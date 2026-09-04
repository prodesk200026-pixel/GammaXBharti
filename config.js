require('dotenv').config();

const STRIKE_STEP = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100, FINNIFTY: 50 };

// Angel One index tokens — confirmed against Angel's own SmartAPI forum
// token-update announcement (99926xxx / 99919xxx series). Used to fetch
// the underlying spot price (needed for ATM strike + Black-Scholes IV).
const ANGEL_INDEX_TOKENS = {
  NIFTY:    { token: '99926000', exchange: 'NSE' },
  BANKNIFTY:{ token: '99926009', exchange: 'NSE' },
  SENSEX:   { token: '99919000', exchange: 'BSE' },
  FINNIFTY: { token: '99926037', exchange: 'NSE' },
};

// Angel's scrip master uses these exact "name" values for option chains
// (not always identical to the index's common name).
const ANGEL_OPTION_NAME = { NIFTY: 'NIFTY', BANKNIFTY: 'BANKNIFTY', SENSEX: 'SENSEX', FINNIFTY: 'FINNIFTY' };

const TRACK_INDICES = (process.env.TRACK_INDICES || 'NIFTY,BANKNIFTY,SENSEX,FINNIFTY')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

module.exports = {
  angel: {
    apiKey: process.env.ANGEL_API_KEY || '',
    clientCode: process.env.ANGEL_CLIENT_CODE || '',
    password: process.env.ANGEL_PIN || '', // Angel's API field is called "password" but the value is your MPIN/PIN
    totpSecret: process.env.ANGEL_TOTP_SECRET || '',
    baseUrl: 'https://apiconnect.angelone.in',
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    contact: process.env.VAPID_SUBJECT || 'mailto:example@example.com',
  },
  server: {
    port: parseInt(process.env.PORT || '10000', 10),
    apiSecret: process.env.API_SECRET || null, // optional — open API if unset
    corsOrigins: process.env.CORS_ORIGINS || '*',
  },
  polling: {
    intervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '15', 10),
    marketHoursOnly: (process.env.MARKET_HOURS_ONLY || 'true').toLowerCase() !== 'false',
  },
  riskFreeRate: parseFloat(process.env.RISK_FREE_RATE || '0.065'), // for the Black-Scholes IV solver

  trackIndices: TRACK_INDICES,
  strikeStep: STRIKE_STEP,
  angelIndexTokens: ANGEL_INDEX_TOKENS,
  angelOptionName: ANGEL_OPTION_NAME,

  defaultStrategyConfig: {
    rsiPeriod: 5,
    rsiEmaPeriod: 5,
    rsiMidLine: 50,
    pullbackMaxRange: 15,
    pullbackMaxCandles: 6,
    emaFastPeriod: 9,
    emaSlowPeriod: 21,
    gannStep: 0.25,
    gannMaxLevel: 3,
    candleTimeframeMinutes: 3,
    strikePremiumMin: 5,
    strikePremiumMax: 30,
    colors: {
      price: '#c9ccd6', emaFast: '#26a69a', emaSlow: '#ef5350',
      rsi: '#7e57c2', rsiEma: '#ffa726', gannLines: '#42a5f5',
      dotGreen: '#2ecc71', straddle: '#26c6da', iv: '#7c4dff',
    },
    lineWidths: { price: 1.5, emaFast: 2, emaSlow: 2, rsi: 1.5, rsiEma: 1.5, gannLines: 1 },
  },
};
