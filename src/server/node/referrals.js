// The HomeFront referral program, savage's part: counting App Store taps on
// invite cards, and working out each month's payouts.
//
// An invite card's "Get BizBuz" button links to /r/:uuid on savage (with the
// same pre-signed query as the card itself) instead of straight to the App
// Store. savage counts the tap and redirects. Each month, 50% of an app's
// proceeds from Apple is shared among the people whose invite cards were
// tapped, in proportion to their taps, capped at $50 a person.
//
// What counts: one tap per visitor per card per day (a visitor is a salted
// hash of IP and user agent, never stored raw), and never link-preview bots
// (iMessage, Slack and friends fetch links to draw previews). A card only
// earns once its owner has connected payouts in GetPayed, which writes a
// payout destination onto the card.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// The only places a tap can redirect to: no open redirect, whatever the
// query says. Keyed by the BDO hash each app publishes its invite card under.
export const REFERRAL_APPS = {
  'bizbuz-referral': { app: 'bizbuz', storeUrl: 'https://apps.apple.com/app/id6808065888' },
  'linkitylink-referral': { app: 'linkitylink', storeUrl: 'https://apps.apple.com/app/id6808065892' },
};

export const POOL_PERCENT = 50;
export const CAP_CENTS = 5000;

const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|facebot|twitterbot|slackbot|discordbot|whatsapp|telegram|linkedin|embedly|quora link preview|skypeuripreview|pinterest|redditbot|applebot|bingpreview|google-inspectiontool|headless|preview|curl|wget|python-requests|go-http-client/i;

export const isBot = (userAgent) => !userAgent || BOT_RE.test(userAgent);

export const visitorKey = (salt, ip, userAgent, uuid, date) =>
  createHash('sha256').update(`${salt}|${ip}|${userAgent}|${uuid}|${date}`).digest('hex').slice(0, 16);

export const monthOf = (date) => date.slice(0, 7);

const isMonth = (m) => /^\d{4}-\d{2}$/.test(m);

/// File-backed store under `dir`: taps-YYYY-MM.json and payouts-YYYY-MM.json.
/// Writes are serialised and atomic (temp file, then rename).
export const createStore = (dir) => {
  let chain = Promise.resolve();
  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  const file = (kind, month) => {
    if (!isMonth(month)) throw new Error(`bad month ${month}`);
    return path.join(dir, `${kind}-${month}.json`);
  };
  const readJson = async (p, fallback) => {
    try {
      return JSON.parse(await fs.readFile(p, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  };
  const writeJson = async (p, value) => {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, p);
  };

  return {
    /// The salt for visitor keys, made once and kept with the data.
    salt: () =>
      serial(async () => {
        const p = path.join(dir, '.salt');
        try {
          return (await fs.readFile(p, 'utf8')).trim();
        } catch {
          const s = randomBytes(32).toString('hex');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(p, s, { mode: 0o600 });
          return s;
        }
      }),

    /// Records a tap; returns true if it counted (first from this visitor
    /// on this card today).
    recordTap: ({ uuid, app, payout, visitor, date }) =>
      serial(async () => {
        const p = file('taps', monthOf(date));
        const data = await readJson(p, {});
        const card = data[uuid] || { app, payout: null, days: {} };
        card.app = app;
        // The latest destination wins: connecting or switching accounts in
        // GetPayed rewrites the card, and payouts go where it says now.
        if (payout) card.payout = payout;
        const day = card.days[date] || [];
        if (day.includes(visitor)) return false;
        day.push(visitor);
        card.days[date] = day;
        data[uuid] = card;
        await writeJson(p, data);
        return true;
      }),

    taps: (month) => readJson(file('taps', month), {}),
    payouts: (month) => readJson(file('payouts', month), null),
    writePayouts: (month, ledger) => serial(() => writeJson(file('payouts', month), ledger)),

    /// Months with any recorded taps, newest first.
    months: async () => {
      try {
        return (await fs.readdir(dir))
          .map((f) => /^taps-(\d{4}-\d{2})\.json$/.exec(f)?.[1])
          .filter(Boolean)
          .sort()
          .reverse();
      } catch {
        return [];
      }
    },
  };
};

export const tapCount = (card) => Object.values(card.days || {}).reduce((n, v) => n + v.length, 0);

const payeeKey = (payout) => `${payout.addieURL}|${payout.pubKey}`;

/// Works out a month's payouts. `proceedsCents` is what Apple paid for each
/// app that month ({ bizbuz: 42000, linkitylink: 8000 }). Each app's pool is
/// POOL_PERCENT of its proceeds, shared by the taps on that app's connected
/// invite cards; each person's total is capped. Shares round down to the
/// cent, so the payouts never exceed the pools.
export const computePayouts = (taps, proceedsCents, { poolPercent = POOL_PERCENT, capCents = CAP_CENTS } = {}) => {
  const payees = new Map();
  const pools = {};
  for (const [app, proceeds] of Object.entries(proceedsCents)) {
    const pool = Math.floor((proceeds * poolPercent) / 100);
    const cards = Object.entries(taps).filter(([, c]) => c.app === app && c.payout && tapCount(c) > 0);
    const total = cards.reduce((n, [, c]) => n + tapCount(c), 0);
    pools[app] = { proceedsCents: proceeds, poolCents: pool, taps: total };
    if (!total || pool <= 0) continue;
    for (const [uuid, card] of cards) {
      const share = Math.floor((pool * tapCount(card)) / total);
      const key = payeeKey(card.payout);
      const p = payees.get(key) || { payout: card.payout, cards: [], taps: 0, earnedCents: 0 };
      p.cards.push(uuid);
      p.taps += tapCount(card);
      p.earnedCents += share;
      payees.set(key, p);
    }
  }
  const list = [...payees.values()]
    .map((p) => ({ ...p, amountCents: Math.min(p.earnedCents, capCents) }))
    .filter((p) => p.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents);
  const poolTotal = Object.values(pools).reduce((n, p) => n + p.poolCents, 0);
  const paid = list.reduce((n, p) => n + p.amountCents, 0);
  return { pools, payees: list, paidCents: paid, retainedCents: poolTotal - paid };
};
