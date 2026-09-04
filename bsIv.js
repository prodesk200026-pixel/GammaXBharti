'use strict';
// ============================================================
// bsIv.js — Black-Scholes European option pricing + implied
// volatility solver. Needed because Angel One's quote API gives
// you LTP but not implied volatility directly (Dhan's option-chain
// API gave IV for free; without Dhan we compute it ourselves).
// ============================================================

function normCdf(x) {
  // Abramowitz & Stegun erf approximation — accurate to ~1e-7
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** European option price under Black-Scholes. type = 'CE' | 'PE'. */
function bsPrice(type, S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === 'CE') return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

function bsVega(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normPdf(d1);
}

/**
 * Solve for implied volatility given a market price. Newton-Raphson
 * with a bisection fallback (NR can diverge for deep ITM/OTM options
 * or when vega is tiny). Returns a decimal (e.g. 0.18 = 18%), or null
 * if it doesn't converge to something sane.
 */
function impliedVolatility(type, marketPrice, S, K, T, r = 0.065) {
  if (marketPrice <= 0 || T <= 0 || S <= 0 || K <= 0) return null;
  const intrinsic = Math.max(0, type === 'CE' ? S - K : K - S);
  if (marketPrice < intrinsic - 0.01) return null; // price below intrinsic — bad/stale quote

  let sigma = 0.3; // starting guess
  for (let i = 0; i < 50; i++) {
    const price = bsPrice(type, S, K, T, r, sigma);
    const vega = bsVega(S, K, T, r, sigma);
    if (vega < 1e-6) break; // NR would blow up — fall through to bisection
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-4) return clampIv(sigma);
    sigma = sigma - diff / vega;
    if (sigma <= 0 || sigma > 5 || !Number.isFinite(sigma)) break; // went off the rails
  }

  // Bisection fallback — slower but always converges for a valid price
  let lo = 0.001, hi = 5.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const price = bsPrice(type, S, K, T, r, mid);
    if (Math.abs(price - marketPrice) < 1e-4) return clampIv(mid);
    if (price > marketPrice) hi = mid; else lo = mid;
  }
  return clampIv((lo + hi) / 2);
}

function clampIv(sigma) {
  const pct = sigma * 100;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 500) return null;
  return pct; // return as a percentage, e.g. 18.4
}

module.exports = { bsPrice, bsVega, impliedVolatility };
