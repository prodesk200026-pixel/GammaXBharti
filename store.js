'use strict';
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { subscriptions: [], strategyConfigs: {}, signalLog: [] };
  }
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// NOTE: Render's free-tier filesystem is ephemeral — it resets on every
// deploy/restart. That's fine for strategyConfigs (you can re-set them
// from the app) but if you want push subscriptions to survive restarts
// long-term, swap this file for a free MongoDB Atlas / Supabase table.
// The load()/save() shape below is intentionally tiny so that swap is
// a 10-line change.

let cache = load();

module.exports = {
  getAll: () => cache,
  addSubscription(sub) {
    const key = sub.endpoint;
    if (!cache.subscriptions.find(s => s.endpoint === key)) {
      cache.subscriptions.push(sub);
      save(cache);
    }
  },
  removeSubscription(endpoint) {
    cache.subscriptions = cache.subscriptions.filter(s => s.endpoint !== endpoint);
    save(cache);
  },
  getSubscriptions: () => cache.subscriptions,
  getStrategyConfig(key, fallback) {
    return cache.strategyConfigs[key] || fallback;
  },
  setStrategyConfig(key, value) {
    cache.strategyConfigs[key] = value;
    save(cache);
  },
  logSignal(entry) {
    cache.signalLog.unshift(entry);
    cache.signalLog = cache.signalLog.slice(0, 200);
    save(cache);
  },
  getSignalLog: () => cache.signalLog,
};
