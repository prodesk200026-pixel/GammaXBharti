'use strict';

/** Exponential moving average. Returns array same length as input, leading values = null until seeded. */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    const v = values[i] * k + prev * (1 - k);
    out[i] = v;
    prev = v;
  }
  return out;
}

/** Wilder's RSI. Returns array same length as input, leading values = null until seeded. */
function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** "Double EMA" = two independent EMA lines used as a band, NOT the DEMA formula. */
function doubleEma(closes, fastPeriod, slowPeriod) {
  return {
    fast: ema(closes, fastPeriod),
    slow: ema(closes, slowPeriod),
  };
}

/**
 * Gann box: caller supplies the impulse leg's low & high.
 * low  -> level 0
 * high -> level = gannStep (default 0.25)
 * one "unit" = (high-low) / gannStep
 * price at level L = low + L * unit
 * For a downtrend (put/mirror) pass invert=true and swap so that
 * `low` = swing-high (level 0) and `high` = swing-low (level gannStep);
 * the math is identical, only which price is "low"/"high" flips.
 */
function gannLevels(low, high, gannStep = 0.25, maxLevel = 3, invert = false) {
  const unit = (high - low) / gannStep;
  const levels = [];
  for (let lvl = 0; lvl <= maxLevel + 1e-9; lvl += gannStep) {
    const rounded = Math.round(lvl * 100) / 100;
    const price = invert ? (low - rounded * unit) : (low + rounded * unit);
    levels.push({ level: rounded, price });
  }
  return levels; // [{level:0, price:low}, {level:0.25, price:high}, {level:0.5, price:...}, ...]
}

function priceAtGannLevel(low, high, level, gannStep = 0.25, invert = false) {
  const unit = (high - low) / gannStep;
  return invert ? (low - level * unit) : (low + level * unit);
}

/** Detect an upward crossover: series `a` moves from <= threshold(b) to > threshold(b) between i-1 and i. */
function crossedUp(aPrev, aCurr, bPrev, bCurr) {
  if ([aPrev, aCurr, bPrev, bCurr].some(v => v === null || v === undefined || Number.isNaN(v))) return false;
  return aPrev <= bPrev && aCurr > bCurr;
}

function crossedDown(aPrev, aCurr, bPrev, bCurr) {
  if ([aPrev, aCurr, bPrev, bCurr].some(v => v === null || v === undefined || Number.isNaN(v))) return false;
  return aPrev >= bPrev && aCurr < bCurr;
}

module.exports = { ema, rsi, doubleEma, gannLevels, priceAtGannLevel, crossedUp, crossedDown };
