'use strict';
const { ema, rsi, doubleEma, priceAtGannLevel, crossedUp, crossedDown } = require('./indicators');

/**
 * States:
 *  IDLE          -> waiting for RSI to be below 50 (or above, for PUT)
 *  ARMED_CROSS   -> RSI is on the correct side of 50, waiting for RSI/RSI-EMA crossover
 *  IMPULSE       -> crossover happened, tracking the impulse leg's extreme (swing) price
 *  PULLBACK      -> price has pulled back from the impulse extreme; validating pullback range
 *                   + double-EMA support/resistance condition
 *  DOT_ARMED     -> pullback validated, waiting for a candle to CLOSE back beyond double EMA
 *  DOT_MARKED    -> green dot fired, waiting for the NEXT candle to close beyond Gann level 0.25
 *  ENTRY         -> entry triggered this tick (consumed by caller then reset to IDLE)
 *
 * direction: 'CALL' (uptrend / RSI crosses EMA from below 50 upward) or
 *            'PUT'  (mirror: RSI crosses EMA from above 50 downward)
 */
class StrategyEngine {
  constructor(cfg, direction) {
    this.cfg = cfg;
    this.direction = direction; // 'CALL' | 'PUT'
    this.state = 'IDLE';
    this.impulseExtreme = null;     // running swing high (CALL) or swing low (PUT) since crossover
    this.impulseStart = null;       // price at the candle where crossover happened
    this.pullbackCandles = [];
    this.dotCandleIndex = null;
    this.gann = null;               // {low, high, invert}
    this.lastSignal = null;
  }

  reset() {
    this.state = 'IDLE';
    this.impulseExtreme = null;
    this.impulseStart = null;
    this.pullbackCandles = [];
    this.dotCandleIndex = null;
    this.gann = null;
  }

  /**
   * candles: array of {t, o, h, l, c} oldest->newest for the configured timeframe.
   * Returns an event object describing what happened on the latest candle, or null.
   */
  update(candles) {
    const cfg = this.cfg;
    const isCall = this.direction === 'CALL';
    if (candles.length < Math.max(cfg.rsiPeriod, cfg.emaSlowPeriod) + cfg.rsiEmaPeriod + 5) return null;

    const closes = candles.map(c => c.c);
    const rsiArr = rsi(closes, cfg.rsiPeriod);
    const rsiEmaArr = ema(rsiArr.map(v => v === null ? closes[0] : v), cfg.rsiEmaPeriod);
    const { fast, slow } = doubleEma(closes, cfg.emaFastPeriod, cfg.emaSlowPeriod);

    const i = candles.length - 1; // latest index
    const prev = i - 1;
    const candle = candles[i];

    const rsiNow = rsiArr[i], rsiPrev = rsiArr[prev];
    const rEmaNow = rsiEmaArr[i], rEmaPrev = rsiEmaArr[prev];
    const emaFastNow = fast[i], emaSlowNow = slow[i];
    // "double ema" band boundary the price must respect (the further one, i.e. tougher condition)
    const bandTop = Math.max(emaFastNow, emaSlowNow);
    const bandBottom = Math.min(emaFastNow, emaSlowNow);

    let event = null;

    switch (this.state) {
      case 'IDLE': {
        const belowMid = rsiNow !== null && rsiNow < cfg.rsiMidLine;
        const aboveMid = rsiNow !== null && rsiNow > cfg.rsiMidLine;
        if (isCall && belowMid) this.state = 'ARMED_CROSS';
        if (!isCall && aboveMid) this.state = 'ARMED_CROSS';
        break;
      }
      case 'ARMED_CROSS': {
        // rule 1: RSI must cross the RSI-EMA from below 50 (CALL) / above 50 (PUT)
        const stillCorrectSide = isCall ? (rsiNow < cfg.rsiMidLine || rsiPrev < cfg.rsiMidLine) : (rsiNow > cfg.rsiMidLine || rsiPrev > cfg.rsiMidLine);
        const crossed = isCall
          ? crossedUp(rsiPrev, rsiNow, rEmaPrev, rEmaNow) && rsiPrev < cfg.rsiMidLine
          : crossedDown(rsiPrev, rsiNow, rEmaPrev, rEmaNow) && rsiPrev > cfg.rsiMidLine;
        if (crossed) {
          this.state = 'IMPULSE';
          this.impulseExtreme = isCall ? candle.h : candle.l;
          this.impulseStart = isCall ? candle.l : candle.h;
          event = { type: 'RSI_CROSS', direction: this.direction, candle };
        } else if (!stillCorrectSide) {
          // RSI wandered back without ever crossing the EMA — go back to watching
          this.state = 'IDLE';
        }
        break;
      }
      case 'IMPULSE': {
        // extend the swing extreme while price keeps making new highs (CALL) / lows (PUT)
        if (isCall && candle.h > this.impulseExtreme) this.impulseExtreme = candle.h;
        if (!isCall && candle.l < this.impulseExtreme) this.impulseExtreme = candle.l;

        // pullback begins once a candle fails to extend the extreme
        const pulledBack = isCall ? candle.h < this.impulseExtreme : candle.h > 0 && candle.l > this.impulseExtreme;
        const startedPullback = isCall ? (candle.h <= this.impulseExtreme && candle.c < candle.o) : (candle.l >= this.impulseExtreme && candle.c > candle.o);
        if (startedPullback) {
          this.state = 'PULLBACK';
          this.pullbackCandles = [candle];
        }
        break;
      }
      case 'PULLBACK': {
        this.pullbackCandles.push(candle);
        if (this.pullbackCandles.length > cfg.pullbackMaxCandles) {
          // pullback dragged on too long / invalidated — start over
          this.reset();
          break;
        }
        const highs = this.pullbackCandles.map(c => c.h);
        const lows = this.pullbackCandles.map(c => c.l);
        const range = Math.max(...highs) - Math.min(...lows);
        // rule 2: pullback high-low must stay within the customisable range
        if (range > cfg.pullbackMaxRange) { this.reset(); break; }

        // rule 4: during pullback, high/close (CALL) must stay above double EMA
        //         (mirror: low/close (PUT) must stay below double EMA)
        const respectsBand = isCall
          ? this.pullbackCandles.every(c => c.h >= bandBottom && c.c >= bandBottom)
          : this.pullbackCandles.every(c => c.l <= bandTop && c.c <= bandTop);
        if (!respectsBand) { this.reset(); break; }

        // pullback candidate is valid so far; set up the Gann box off this leg
        const low = isCall ? this.impulseStart : this.impulseExtreme;
        const high = isCall ? this.impulseExtreme : this.impulseStart;
        this.gann = { low, high, invert: !isCall };
        this.state = 'DOT_ARMED';
        break;
      }
      case 'DOT_ARMED': {
        // rule 5 (part 1): candle CLOSES back beyond the double EMA -> green dot
        const closedBack = isCall ? candle.c > bandTop : candle.c < bandBottom;
        if (closedBack) {
          this.state = 'DOT_MARKED';
          this.dotCandleIndex = i;
          event = { type: 'GREEN_DOT', direction: this.direction, candle, gann: this.gann };
        } else {
          // still respecting the band? otherwise invalidate
          const stillOk = isCall ? candle.l >= bandBottom * 0.999 : candle.h <= bandTop * 1.001;
          if (!stillOk) this.reset();
        }
        break;
      }
      case 'DOT_MARKED': {
        // rule 5 (part 2): the candle AFTER the dot must close beyond Gann level 0.25 (= impulse high/low)
        const level25 = priceAtGannLevel(this.gann.low, this.gann.high, cfg.gannStep, cfg.gannStep, this.gann.invert); // level == cfg.gannStep (i.e. 0.25)
        const triggered = isCall ? candle.c > level25 : candle.c < level25;
        if (triggered) {
          this.state = 'ENTRY';
          event = {
            type: 'ENTRY',
            direction: this.direction,
            candle,
            gann: this.gann,
            entryPrice: candle.c,
            targets: this.buildTargets(),
          };
        } else {
          this.reset();
        }
        break;
      }
      case 'ENTRY': {
        this.reset();
        break;
      }
    }

    if (event) this.lastSignal = { ...event, at: candle.t };
    return event;
  }

  buildTargets() {
    const cfg = this.cfg;
    const { low, high, invert } = this.gann;
    const out = [];
    for (let lvl = cfg.gannStep; lvl <= cfg.gannMaxLevel + 1e-9; lvl += cfg.gannStep) {
      const rounded = Math.round(lvl * 100) / 100;
      out.push({ level: rounded, price: priceAtGannLevel(low, high, rounded, cfg.gannStep, invert) });
    }
    return out;
  }
}

module.exports = { StrategyEngine };
