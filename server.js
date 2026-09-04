'use strict';
const express = require('express');
const cors = require('cors');

const cfg = require('./config');
const store = require('./store');
const { initPush, broadcast } = require('./push');
const { StrategyEngine } = require('./strategy');
const { CrossoverWatcher } = require('./straddleIvWatcher');
const { AngelOneBroker } = require('./angelone');
const { impliedVolatility } = require('./bsIv');

const app = express();
app.use(cors(cfg.server.corsOrigins === '*' ? { origin: true } : { origin: cfg.server.corsOrigins.split(',').map(s => s.trim()) }));
app.use(express.json());
initPush(cfg);

const angel = new AngelOneBroker(cfg);

const runtime = {};
for (const idx of cfg.trackIndices) {
  const strat = store.getStrategyConfig(idx, cfg.defaultStrategyConfig);
  runtime[idx] = {
    candles: [],
    call: new StrategyEngine(strat, 'CALL'),
    put: new StrategyEngine(strat, 'PUT'),
    straddleW: new CrossoverWatcher(`${idx} Straddle x Price`),
    ivW: new CrossoverWatcher(`${idx} IV x Price`),
    status: { lastUpdate: null, underlyingPrice: null, atmStrike: null, straddlePrice: null, atmIv: null, callState: 'IDLE', putState: 'IDLE', candleProvider: 'NONE', alerts: [] },
  };
}

function requireSecret(req, res, next) {
  if (!cfg.server.apiSecret) return next();
  const secret = req.header('x-api-secret') || req.query.secret;
  if (secret !== cfg.server.apiSecret) return res.status(401).json({ error: 'bad secret' });
  next();
}

function isMarketHoursNowIST() {
  if (!cfg.polling.marketHoursOnly) return true;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

function fmtDateAngel(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseAngelExpiryToDate(s) {
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(s);
  if (!m) return null;
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const mo = months[m[2]];
  if (mo === undefined) return null;
  const d = new Date(Number(m[3]), mo, Number(m[1]), 15, 30); // NSE/BSE expiry cutoff ~3:30pm
  return d;
}

async function pollIndex(idx) {
  const rt = runtime[idx];
  const angelMeta = cfg.angelIndexTokens[idx];
  if (!rt || !angelMeta || !angel.isConfigured()) return;

  // 1. candles
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 24 * 60 * 60 * 1000);
    const candles = await angel.getIndexCandles(angelMeta, rt.call.cfg.candleTimeframeMinutes, fmtDateAngel(from), fmtDateAngel(to));
    if (candles && candles.length) { rt.candles = candles; rt.status.candleProvider = 'ANGELONE'; }
  } catch (e) {
    console.error(`[${idx}] Angel candle fetch failed:`, e.message);
  }

  // 2. spot price (for ATM strike + Black-Scholes) + strike band + straddle/IV
  let atm = null;
  try {
    const spotRows = await angel.getQuoteBulk({ [angelMeta.exchange]: [angelMeta.token] }, 'LTP');
    const spotPrice = spotRows[0] && spotRows[0].ltp;
    if (spotPrice) {
      const optionName = cfg.angelOptionName[idx];
      const step = cfg.strikeStep[idx];
      const expiries = await angel.listExpiries(optionName);
      const nearestExpiry = expiries[0];
      if (nearestExpiry) {
        const { atmStrike, band } = await angel.resolveStrikeBand(optionName, nearestExpiry, spotPrice, step, 6);
        const tokensByExch = {};
        for (const row of band) {
          tokensByExch[row.exch] = tokensByExch[row.exch] || [];
          tokensByExch[row.exch].push(row.token);
        }
        const quotes = await angel.getQuoteBulk(tokensByExch, 'LTP');
        const byToken = new Map(quotes.map(q => [String(q.symbolToken), q.ltp]));
        const expiryDate = parseAngelExpiryToDate(nearestExpiry);
        const T = expiryDate ? Math.max((expiryDate - new Date()) / (365 * 24 * 60 * 60 * 1000), 1 / 365) : 7 / 365;

        const atmCe = band.find(r => r.strike === atmStrike && r.side === 'CE');
        const atmPe = band.find(r => r.strike === atmStrike && r.side === 'PE');
        const ceLtp = atmCe ? byToken.get(String(atmCe.token)) : null;
        const peLtp = atmPe ? byToken.get(String(atmPe.token)) : null;

        if (ceLtp != null && peLtp != null) {
          const ceIv = impliedVolatility('CE', ceLtp, spotPrice, atmStrike, T, cfg.riskFreeRate);
          const peIv = impliedVolatility('PE', peLtp, spotPrice, atmStrike, T, cfg.riskFreeRate);
          const ivs = [ceIv, peIv].filter(v => v !== null);
          atm = {
            underlyingPrice: spotPrice,
            strike: atmStrike,
            straddlePrice: ceLtp + peLtp,
            atmIv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
            band, byToken, T,
          };
        }
      }
    }
  } catch (e) {
    console.error(`[${idx}] Angel option/spot fetch failed:`, e.message);
  }

  // 3. strategy engines
  if (rt.candles.length) {
    const evCall = rt.call.update(rt.candles);
    const evPut = rt.put.update(rt.candles);
    rt.status.callState = rt.call.state;
    rt.status.putState = rt.put.state;
    for (const ev of [evCall, evPut].filter(Boolean)) await handleStrategyEvent(idx, ev, atm);
  }

  // 4. straddle / IV crossover watchers
  if (atm) {
    rt.status.underlyingPrice = atm.underlyingPrice;
    rt.status.atmStrike = atm.strike;
    rt.status.straddlePrice = atm.straddlePrice;
    rt.status.atmIv = atm.atmIv;
    if (atm.atmIv != null) {
      const sEv = rt.straddleW.push(atm.underlyingPrice, atm.straddlePrice);
      const iEv = rt.ivW.push(atm.underlyingPrice, atm.atmIv);
      for (const ev of [sEv, iEv].filter(Boolean)) {
        rt.status.alerts.unshift({ ...ev, kind: 'CROSSOVER' });
        rt.status.alerts = rt.status.alerts.slice(0, 20);
        store.logSignal({ index: idx, ...ev, kind: 'CROSSOVER' });
        await notify(ev.name, `${ev.direction === 'UP' ? '🟢 Crossed UP' : '🔴 Crossed DOWN'} — Price ${ev.price.toFixed(1)} vs ${ev.indicatorValue.toFixed(1)}`);
      }
    }
  }
  rt.status.lastUpdate = new Date().toISOString();
}

function findStrikeInPremiumRange(atm, side, min, max) {
  if (!atm || !atm.band) return null;
  const rows = atm.band
    .filter(r => r.side === side)
    .map(r => ({ strike: r.strike, ltp: atm.byToken.get(String(r.token)) }))
    .filter(r => typeof r.ltp === 'number');
  const inRange = rows.filter(r => r.ltp >= min && r.ltp <= max);
  if (!inRange.length) return null;
  const mid = (min + max) / 2;
  inRange.sort((a, b) => Math.abs(a.ltp - mid) - Math.abs(b.ltp - mid));
  return inRange[0];
}

async function handleStrategyEvent(idx, ev, atm) {
  const rt = runtime[idx];
  rt.status.alerts.unshift({ ...ev, kind: 'STRATEGY' });
  rt.status.alerts = rt.status.alerts.slice(0, 20);
  store.logSignal({ index: idx, type: ev.type, direction: ev.direction, at: ev.at, kind: 'STRATEGY' });

  if (ev.type === 'GREEN_DOT') {
    await notify(`${idx} ${ev.direction} — Green Dot`, `Candle closed beyond double EMA. Watching next candle for Gann 0.25 break.`);
  }
  if (ev.type === 'ENTRY') {
    const side = ev.direction === 'CALL' ? 'CE' : 'PE';
    const pick = findStrikeInPremiumRange(atm, side, rt.call.cfg.strikePremiumMin, rt.call.cfg.strikePremiumMax);
    const strikeMsg = pick
      ? `Suggested strike: ${pick.strike} ${side} @ ~${pick.ltp}`
      : `No strike found in ₹${rt.call.cfg.strikePremiumMin}-${rt.call.cfg.strikePremiumMax} premium band right now.`;
    rt.status.alerts.unshift({ kind: 'ENTRY_CARD', index: idx, direction: ev.direction, strikePick: pick, targets: ev.targets, at: Date.now() });
    await notify(`🚀 ${idx} ${ev.direction} ENTRY`, strikeMsg);
  }
}

async function notify(title, body) {
  const subs = store.getSubscriptions();
  if (!subs.length) return;
  await broadcast(subs, { title, body, tag: 'index-signal-' + Date.now() });
}

async function pollAll() {
  if (!isMarketHoursNowIST()) return;
  for (const idx of cfg.trackIndices) {
    try { await pollIndex(idx); } catch (e) { console.error(`[${idx}] poll error`, e.message); }
  }
}

// ---------------- boot sequence ----------------
app.get('/', (req, res) => res.json({ ok: true, service: 'gamma-x-angel-only-backend', see: ['/health', '/api/health', '/api/status'] }));
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));
app.get('/api/health', (req, res) => {
  const perIndex = {};
  for (const idx of cfg.trackIndices) perIndex[idx] = { candleProvider: runtime[idx].status.candleProvider, lastUpdate: runtime[idx].status.lastUpdate };
  res.json({
    ok: true,
    indices: cfg.trackIndices,
    // Kept for compatibility with frontends built against the earlier
    // Dhan+Angel backend contract — Dhan is intentionally unused now,
    // but the field shapes still exist so old frontend code that reads
    // data.dhan.* / data.angelOne.* / data.brokerOrder doesn't crash.
    brokerOrder: ['ANGEL'],
    dhan: { configured: false, hasCredentials: false, hasToken: false, tokenExpiryTime: null, lastAuthError: null, lastAuthErrorAt: null },
    angelOne: { configured: angel.isConfigured() },
    broker: 'ANGEL_ONLY',
    angelConfigured: angel.isConfigured(),
    perIndex,
    time: Date.now(),
  });
});
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: cfg.vapid.publicKey }));
app.post('/api/subscribe', requireSecret, (req, res) => { store.addSubscription(req.body); res.json({ ok: true }); });
app.post('/api/unsubscribe', requireSecret, (req, res) => { store.removeSubscription(req.body.endpoint); res.json({ ok: true }); });
app.get('/api/status', requireSecret, (req, res) => {
  const out = {};
  for (const idx of cfg.trackIndices) out[idx] = runtime[idx].status;
  res.json(out);
});
app.get('/api/config/:index', requireSecret, (req, res) => res.json(store.getStrategyConfig(req.params.index.toUpperCase(), cfg.defaultStrategyConfig)));
app.post('/api/config/:index', requireSecret, (req, res) => {
  const idx = req.params.index.toUpperCase();
  const merged = { ...cfg.defaultStrategyConfig, ...store.getStrategyConfig(idx, {}), ...req.body };
  store.setStrategyConfig(idx, merged);
  if (runtime[idx]) { runtime[idx].call.cfg = merged; runtime[idx].put.cfg = merged; }
  res.json(merged);
});
app.get('/api/signal-log', requireSecret, (req, res) => res.json(store.getSignalLog()));

app.listen(cfg.server.port, () => {
  console.log(`Backend listening on :${cfg.server.port} | tracking ${cfg.trackIndices.join(', ')} | broker=ANGEL_ONLY`);
  pollAll();
  setInterval(pollAll, cfg.polling.intervalSeconds * 1000);
});
