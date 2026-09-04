# Gamma X — Angel One-only backend

Dhan removed entirely, as asked. This runs purely on Angel One SmartAPI.

## Why your Netlify app said "Backend unreachable"

Your `/api/health` screenshot (image 2) shows the backend **was** live
and responding correctly at that moment. The "Backend unreachable...
Render may be waking up, retry ~30s" message is that Netlify app's own
built-in handling of **Render's free-tier cold start** — a free Render
web service spins down after ~15 minutes with no traffic, and the next
request takes ~20-50 seconds to wake it back up. That's not a bug in
this backend; it's a Render free-tier limitation. Two ways to deal with
it:
- Accept the occasional 30s wake-up delay (fine for casual checking).
- Set up a free uptime pinger (e.g. UptimeRobot) hitting `/health` every
  5 minutes, which keeps the free instance warm during market hours.
- Or upgrade that one Render service to a paid instance (~$7/mo) for
  always-on.

## What changed — Dhan removed, Angel One does everything

- **Candles**: `angel.getIndexCandles()` — unchanged, was already working.
- **ATM straddle price**: Angel has no native option-chain endpoint, so
  this backend now resolves it itself: fetch the spot price (Angel LTP
  on the index token) → find the nearest expiry and ATM strike from
  Angel's own scrip master → bulk-quote the CE and PE at that strike →
  straddle price = CE LTP + PE LTP.
- **ATM IV**: Angel doesn't give you implied volatility at all (Dhan
  did, for free). This backend now **computes it itself** with a
  Black-Scholes implied-volatility solver (`bsIv.js`, Newton-Raphson
  with a bisection fallback) — verified against a textbook example
  round-trip (price a 20% IV option, solve back, get exactly 20%) before
  going anywhere near this code.
  - Uses a configurable risk-free rate (`RISK_FREE_RATE`, default 6.5%
    for India) and time-to-expiry computed from the option's actual
    expiry date.
  - **Honest limitation**: Black-Scholes assumes European exercise, no
    dividends, and constant volatility — index options are reasonably
    close to these assumptions, but this IV number will not be
    bit-for-bit identical to what a broker's official Greeks feed shows.
    It's a solid approximation for the crossover-detection logic, not a
    replacement for a real Greeks API.
- **Strike selection for entries** (₹5-30 premium band): now scans the
  same ATM ± 6 strikes band already fetched above, no extra API calls.
- Bulk quotes use Angel's `/market/v1/quote` endpoint (up to 50
  instruments per call, confirmed from Angel's own SmartAPI forum
  announcement) instead of calling LTP one strike at a time.

## VAPID keys — freshly generated for you

`.env.example` already has a **real, working VAPID keypair**, generated
locally with Node's built-in crypto (no network call, no reused key from
anywhere else):

```
VAPID_PUBLIC_KEY=BA6jpbI4NvVlgzH1VWIJX4GXM2hcQMwH5ay_JHf9g5qC8Ff89icKfhJAbH9TF_hVKBYXexaNY311-P1m7fjdhN4
VAPID_PRIVATE_KEY=Ro-37G9JDHzZchO88Jyt-CH4rRRc_uQuTgBjWIhCauc
```

I verified the format by hand: the public key decodes to exactly 65
bytes starting with `0x04` (uncompressed EC point) and the private key
decodes to exactly 32 bytes — the exact shape `web-push`'s own
`generateVAPIDKeys()` produces. Paste these into both:
- your **backend's** Render environment (`VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY`), and
- wherever your **frontend** (the Netlify app) asks for the VAPID
  public key to subscribe to push.

Treat `VAPID_PRIVATE_KEY` like a password — don't share it publicly.

## Files (all flat at root — no subfolders, learned that lesson last time)

- `server.js` — Express app, polling loop, all `/api/*` routes
- `config.js` — every setting in one place
- `angelone.js` — Angel One login, candles, scrip master, bulk quotes,
  expiry/ATM-strike resolution
- `bsIv.js` — Black-Scholes pricing + implied-volatility solver
- `strategy.js`, `indicators.js`, `straddleIvWatcher.js` — the RSI/Gann/
  double-EMA strategy engine (unchanged from before, already tested)
- `store.js` — push subscriptions + per-index settings (flat JSON file)
- `push.js` — Web Push wrapper

## Deploy

1. Replace your repo contents with every file in this zip (root level,
   no folders).
2. Render → Environment → set `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`,
   `ANGEL_PIN`, `ANGEL_TOTP_SECRET`, and the two `VAPID_*` keys above.
3. Confirm Render → Settings → Health Check Path = `/health`.
4. Check `/health` then `/api/health` after it deploys.

## What I still couldn't verify live

No internet access in my sandbox, so the real Angel One login, quote,
and scrip-master calls are untested against live data — only boot-tested
with every network call simulated as failing (confirmed: no crash, clean
error logs). If `/api/health` shows `angelConfigured: true` but candles
stay `NONE`, check the Render logs for the actual Angel error message —
most common causes are TOTP not enabled on the account yet, or an
expired/wrong PIN.
