'use strict';
const axios = require('axios');
const { authenticator } = require('otplib');

// Angel One does NOT publish a ready-made option-chain endpoint. The
// standard workaround (used across the whole SmartAPI community — see
// the SmartAPI forum) is: download the daily Scrip/Instrument master,
// filter it for the option symbols you need, then call the quote/LTP
// endpoint for those specific tokens. That's what this adapter does.
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

class AngelOneBroker {
  constructor(cfg) {
    this.cfg = cfg.angel;
    this.client = axios.create({ baseURL: this.cfg.baseUrl, timeout: 10000 });
    this.jwt = null;
    this.scripMasterCache = null;
    this.scripMasterCachedAt = 0;
  }

  isConfigured() {
    return !!(this.cfg.apiKey && this.cfg.clientCode && this.cfg.password && this.cfg.totpSecret);
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${this.jwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': this.cfg.apiKey,
    };
  }

  async login() {
    const totp = authenticator.generate(this.cfg.totpSecret);
    const { data } = await this.client.post(
      '/rest/auth/angelbroking/user/v1/loginByPassword',
      { clientcode: this.cfg.clientCode, password: this.cfg.password, totp },
      { headers: { 'Content-Type': 'application/json', 'X-PrivateKey': this.cfg.apiKey, 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00' } }
    );
    if (!data || !data.data || !data.data.jwtToken) throw new Error('Angel One login failed: ' + JSON.stringify(data));
    this.jwt = data.data.jwtToken;
    return this.jwt;
  }

  async ensureLogin() {
    if (!this.jwt) await this.login();
  }

  async getScripMaster() {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (this.scripMasterCache && Date.now() - this.scripMasterCachedAt < ONE_DAY) return this.scripMasterCache;
    const { data } = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
    this.scripMasterCache = data;
    this.scripMasterCachedAt = Date.now();
    return data;
  }

  /** interval e.g. 'THREE_MINUTE'; from/to format 'YYYY-MM-DD HH:mm' */
  async getCandles(symbolToken, exchange, interval, fromDate, toDate) {
    await this.ensureLogin();
    const { data } = await this.client.post(
      '/rest/secure/angelbroking/historical/v1/getCandleData',
      { exchange, symboltoken: symbolToken, interval, fromdate: fromDate, todate: toDate },
      { headers: this.authHeaders() }
    );
    if (!data || !Array.isArray(data.data)) return [];
    return data.data.map(row => ({ t: new Date(row[0]).getTime(), o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] }));
  }

  static minutesToInterval(mins) {
    const map = { 1: 'ONE_MINUTE', 3: 'THREE_MINUTE', 5: 'FIVE_MINUTE', 10: 'TEN_MINUTE', 15: 'FIFTEEN_MINUTE', 30: 'THIRTY_MINUTE', 60: 'ONE_HOUR' };
    return map[mins] || 'THREE_MINUTE';
  }

  /** meta = the `angel: { token, exchange }` block from config.indexMap[idx] */
  async getIndexCandles(meta, candleTimeframeMinutes, fromDate, toDate) {
    const interval = AngelOneBroker.minutesToInterval(candleTimeframeMinutes);
    return this.getCandles(meta.token, meta.exchange, interval, fromDate, toDate);
  }

  async getLtp(exchange, tradingSymbol, symbolToken) {
    await this.ensureLogin();
    const { data } = await this.client.post(
      '/rest/secure/angelbroking/order/v1/getLtpData',
      { exchange, tradingsymbol: tradingSymbol, symboltoken: symbolToken },
      { headers: this.authHeaders() }
    );
    return data && data.data ? data.data : null;
  }

  /** Find option instruments for `name` (NIFTY/BANKNIFTY/SENSEX/FINNIFTY) nearest `expiry` (DDMMMYYYY, e.g. 25SEP26). */
  async findOptionInstruments(name, expiry) {
    const master = await this.getScripMaster();
    return master.filter(row =>
      row.name === name &&
      row.expiry === expiry &&
      (row.symbol.endsWith('CE') || row.symbol.endsWith('PE'))
    );
  }

  /** All upcoming option expiries for an index name, soonest first (DDMMMYYYY strings, e.g. "25SEP2025"). */
  async listExpiries(name) {
    const master = await this.getScripMaster();
    const today = new Date();
    const set = new Map(); // dateStr -> Date, for sorting
    for (const row of master) {
      if (row.name !== name || row.instrumenttype !== 'OPTIDX' || !row.expiry) continue;
      const d = parseAngelExpiry(row.expiry);
      if (d && d >= today) set.set(row.expiry, d);
    }
    return Array.from(set.entries()).sort((a, b) => a[1] - b[1]).map(([str]) => str);
  }

  /**
   * Resolves the ATM strike and a band of CE/PE rows around it for a
   * given index + expiry, using Angel's own scrip master (strike prices
   * there are scaled x100, e.g. "2350000.00" = strike 23500).
   */
  async resolveStrikeBand(name, expiry, spotPrice, strikeStep, rangeSteps = 6) {
    const master = await this.getScripMaster();
    const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
    const rows = master.filter(row => row.name === name && row.expiry === expiry && row.instrumenttype === 'OPTIDX');
    const band = [];
    for (const row of rows) {
      const strike = parseFloat(row.strike) / 100;
      if (Math.abs(strike - atmStrike) <= rangeSteps * strikeStep + 1e-6) {
        const side = row.symbol.endsWith('CE') ? 'CE' : row.symbol.endsWith('PE') ? 'PE' : null;
        if (side) band.push({ strike, side, token: row.token, exch: row.exch_seg || 'NFO' });
      }
    }
    return { atmStrike, band };
  }

  /**
   * Bulk quote — up to 50 tokens per call, grouped by exchange segment.
   * exchangeTokens = { NFO: ['12345','12346'], NSE: ['99926000'] }
   * mode: 'LTP' | 'OHLC' | 'FULL'
   */
  async getQuoteBulk(exchangeTokens, mode = 'LTP') {
    await this.ensureLogin();
    const { data } = await this.client.post(
      '/rest/secure/angelbroking/market/v1/quote',
      { mode, exchangeTokens },
      { headers: this.authHeaders() }
    );
    const fetched = data && data.data && Array.isArray(data.data.fetched) ? data.data.fetched : [];
    return fetched; // each: { exchange, tradingSymbol, symbolToken, ltp, ... }
  }
}

function parseAngelExpiry(s) {
  // "25SEP2025" -> Date
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(s);
  if (!m) return null;
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const mo = months[m[2]];
  if (mo === undefined) return null;
  return new Date(Number(m[3]), mo, Number(m[1]));
}

module.exports = { AngelOneBroker };
