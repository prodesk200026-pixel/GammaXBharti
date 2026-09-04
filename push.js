'use strict';
const webpush = require('web-push');

function initPush(cfg) {
  if (cfg.vapid.publicKey && cfg.vapid.privateKey) {
    webpush.setVapidDetails(cfg.vapid.contact, cfg.vapid.publicKey, cfg.vapid.privateKey);
  }
}

/**
 * subscriptions: array of PushSubscription objects saved from the browser.
 * payload: plain object — the service-worker turns this into a system
 * notification (with sound + vibration) so it fires even if the phone
 * screen is off / the PWA is not open. Actual reliability still depends
 * on the OS: Android Chrome is very reliable; iOS Safari needs the PWA
 * to have been "Added to Home Screen" (iOS 16.4+) to receive Web Push
 * at all — plain Safari tabs cannot.
 */
async function broadcast(subscriptions, payload) {
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subscriptions.map(sub => webpush.sendNotification(sub, body))
  );
  return results;
}

module.exports = { initPush, broadcast };
