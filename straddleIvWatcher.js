'use strict';

/**
 * Reproduces the "ATM Straddle" / "ATM IV" charts you referenced: the
 * underlying price is rescaled onto the indicator's own min/max range
 * (over a rolling window) so the two lines share one visual scale, and
 * a signal fires the instant the rescaled price line crosses the
 * indicator line. Two independent watchers run per index — one for
 * straddle price, one for IV — each gets its own named alert box.
 */
class CrossoverWatcher {
  constructor(name, windowSize = 60) {
    this.name = name; // e.g. "NIFTY Straddle x Price" / "NIFTY IV x Price"
    this.windowSize = windowSize;
    this.priceHist = [];
    this.indicatorHist = [];
    this.lastCrossDirection = null;
  }

  /** Call on every new tick/candle close. Returns an event or null. */
  push(price, indicatorValue) {
    this.priceHist.push(price);
    this.indicatorHist.push(indicatorValue);
    if (this.priceHist.length > this.windowSize) this.priceHist.shift();
    if (this.indicatorHist.length > this.windowSize) this.indicatorHist.shift();
    if (this.priceHist.length < 5) return null;

    const pMin = Math.min(...this.priceHist), pMax = Math.max(...this.priceHist);
    const iMin = Math.min(...this.indicatorHist), iMax = Math.max(...this.indicatorHist);
    const rescale = v => (pMax === pMin) ? iMin : iMin + ((v - pMin) / (pMax - pMin)) * (iMax - iMin);

    const rNow = rescale(price);
    const rPrev = rescale(this.priceHist[this.priceHist.length - 2]);
    const iNow = indicatorValue;
    const iPrev = this.indicatorHist[this.indicatorHist.length - 2];

    let direction = null;
    if (rPrev <= iPrev && rNow > iNow) direction = 'UP';
    if (rPrev >= iPrev && rNow < iNow) direction = 'DOWN';

    if (direction && direction !== this.lastCrossDirection) {
      this.lastCrossDirection = direction;
      return { name: this.name, direction, price, indicatorValue, at: Date.now() };
    }
    if (!direction) this.lastCrossDirection = null;
    return null;
  }
}

module.exports = { CrossoverWatcher };
