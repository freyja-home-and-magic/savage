// Where HomeFront's App Store links go, and how savage tells a visitor
// from a bot. Taps and views are counted, and paid, by pool.js.
//
// An invite card's "Get BizBuz" button, and an ordinary card page's "Make
// your own", link to /r/:uuid on savage (with the card's own pre-signed
// query) instead of straight to the App Store. savage counts the tap and
// redirects.

import { createHash } from 'node:crypto';

// The only places a tap can redirect to: no open redirect, whatever the
// query says. Keyed by the BDO hash each app publishes under: its invite
// card, and its ordinary cards, whose pages carry a "make your own" button
// (getAppCta). A tap on either earns the card's owner a nineum (pool.js).
const BIZBUZ_STORE = 'https://apps.apple.com/app/id6808065888';
const LINKITYLINK_STORE = 'https://apps.apple.com/app/id6808065892';
export const REFERRAL_APPS = {
  'bizbuz-referral': { app: 'bizbuz', storeUrl: BIZBUZ_STORE, kind: 'invite' },
  'linkitylink-referral': { app: 'linkitylink', storeUrl: LINKITYLINK_STORE, kind: 'invite' },
  'bizbuz-card': { app: 'bizbuz', storeUrl: BIZBUZ_STORE, kind: 'card', cta: 'Make your own card with BizBuz' },
  'linkitylink-card': { app: 'linkitylink', storeUrl: LINKITYLINK_STORE, kind: 'card', cta: 'Make your own link page with Linkitylink' },
};

/// The "make your own" button for a card's page, or null: only on ordinary
/// BizBuz and Linkitylink cards (an invite card is already one big button),
/// and only when switched on (SAVAGE_GET_APP_CTA=on).
export const getAppCta = (hash, href, enabled) => {
  const app = REFERRAL_APPS[hash];
  if (!enabled || !app || app.kind !== 'card') return null;
  return { label: app.cta, href };
};

const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|facebot|twitterbot|slackbot|discordbot|whatsapp|telegram|linkedin|embedly|quora link preview|skypeuripreview|pinterest|redditbot|applebot|bingpreview|google-inspectiontool|headless|preview|curl|wget|python-requests|go-http-client/i;

export const isBot = (userAgent) => !userAgent || BOT_RE.test(userAgent);

export const visitorKey = (salt, ip, userAgent, uuid, date) =>
  createHash('sha256').update(`${salt}|${ip}|${userAgent}|${uuid}|${date}`).digest('hex').slice(0, 16);
