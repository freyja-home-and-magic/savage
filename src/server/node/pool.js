// The HomeVentory payment pool, savage's part (getpayed/PAYMENT_POOL.md).
//
// Useful actions earn the person behind a card nineum in HomeVentory's
// Fount galaxy, where a nineum's period byte names the month it was minted
// (fount: PERIOD_GALAXIES). After each month, 50% of what Apple paid for the
// apps that month is shared among the people who earned nineum in it, by
// count, with a cap at two standard deviations above the average share. The
// numbers stay with their holders afterwards but pay nothing more.
//
// Who: every HomeFront user has one HomeFront identity (a sessionless key
// shared by the apps through the keychain), registered here once. The
// registration is a Fount create request they signed, which savage passes
// to Fount, so Fount's answer proves which uuid belongs to the pubKey.
// Cards then carry that pubKey as `fount: { pubKey }`. Anyone can write any
// pubKey on a card, but that only gifts nineum to its holder; a payout
// destination can only be set by the identity itself (signed), so nobody
// can redirect someone else's money.
//
// What earns (one nineum each):
//   tap       an App Store tap on an invite card or a card's "Make your own"
//   view      a view of a BizBuz or Linkitylink card's page
//   share     the owner sharing their card from the app (once per card a day)
//   purchase  a GetPayed invoice paid, credited to the person who sent it
// Taps and views count once per visitor per card per day, never bots.
// Nothing is tracked through a referral's referrals.

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const POOL_PERCENT = 50;

/// Each action's nineum direction byte, so a nineum says what earned it.
export const ACTIONS = { tap: '01', view: '02', share: '03', purchase: '04' };

export const isPubKey = (v) => typeof v === 'string' && /^0[23][0-9a-f]{64}$/i.test(v);

export const monthOf = (date) => date.slice(0, 7);
const isMonth = (m) => /^\d{4}-\d{2}$/.test(m);

/// The card's owner, as the card itself says, or null.
export const cardMember = (bdo) => {
  const pubKey = bdo?.fount?.pubKey;
  return isPubKey(pubKey) ? pubKey.toLowerCase() : null;
};

/// File-backed store under `dir`:
///   members.json          pubKey -> { uuid, payout, registeredAt }
///   events-YYYY-MM.json   { events: [...], seen: { dedupeKey: 1 } }
///   payouts-YYYY-MM.json  the payout ledger for a month
///   .salt                 for visitor keys
/// Writes are serialised and atomic (temp file, then rename).
export const createPoolStore = (dir) => {
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
  const membersFile = path.join(dir, 'members.json');

  const months = async () => {
    try {
      return (await fs.readdir(dir))
        .map((f) => /^events-(\d{4}-\d{2})\.json$/.exec(f)?.[1])
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  };

  return {
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

    /// Records an action once per `dedupe` key; returns true if it counted.
    record: ({ action, member, card = null, app = null, dedupe, date }) =>
      serial(async () => {
        if (!ACTIONS[action]) throw new Error(`unknown action ${action}`);
        const p = file('events', monthOf(date));
        const data = await readJson(p, { events: [], seen: {} });
        if (data.seen[dedupe]) return false;
        data.seen[dedupe] = 1;
        data.events.push({ action, member, card, app, date, granted: null });
        await writeJson(p, data);
        return true;
      }),

    /// Registers (or refreshes) a member. `payout` only replaces the stored
    /// destination when given.
    register: (pubKey, uuid, payout) =>
      serial(async () => {
        const members = await readJson(membersFile, {});
        const m = members[pubKey] || { uuid, payout: null, registeredAt: new Date().toISOString() };
        m.uuid = uuid;
        if (payout) m.payout = payout;
        members[pubKey] = m;
        await writeJson(membersFile, members);
        return m;
      }),

    members: () => readJson(membersFile, {}),

    /// Every event not yet minted, grouped as { month: [index, ...] }.
    ungranted: async () => {
      const out = {};
      for (const month of await months()) {
        const data = await readJson(file('events', month), { events: [] });
        const idx = data.events.flatMap((e, i) => (e.granted ? [] : [i]));
        if (idx.length) out[month] = { events: data.events, idx };
      }
      return out;
    },

    /// Marks events as minted in `period` (the month the nineum carry).
    markGranted: (month, indexes, period) =>
      serial(async () => {
        const p = file('events', month);
        const data = await readJson(p, { events: [], seen: {} });
        for (const i of indexes) if (data.events[i]) data.events[i].granted = period;
        await writeJson(p, data);
      }),

    /// Nineum minted in `period`, by member: { pubKey: count }. Events are
    /// filed by the month they happened in, and minted shortly after, so a
    /// period's nineum can sit in its own month's file or the one before.
    tally: async (period) => {
      const counts = {};
      for (const month of await months()) {
        if (month > period) continue;
        const data = await readJson(file('events', month), { events: [] });
        for (const e of data.events) {
          if (e.granted === period) counts[e.member] = (counts[e.member] || 0) + 1;
        }
      }
      return counts;
    },

    /// One card's actions and its owner's nineum, for the app's share screen.
    cardActivity: async (card, month) => {
      const data = await readJson(file('events', month), { events: [] });
      const actions = { tap: 0, view: 0, share: 0, purchase: 0 };
      for (const e of data.events) if (e.card === card) actions[e.action]++;
      return actions;
    },

    payouts: (month) => readJson(file('payouts', month), null),
    writePayouts: (month, ledger) => serial(() => writeJson(file('payouts', month), ledger)),
    months,
  };
};

// ── Paying ──────────────────────────────────────────────────────────────────

/// Works out a month's payouts, as PAYMENT_POOL.md describes.
///
/// `tally` is { pubKey: nineum minted that month }. `members` gives each
/// pubKey's payout destination; only people with one take part (the rest
/// keep their nineum, unpaid). The pool is POOL_PERCENT of `proceedsCents`.
///
/// 1. Everyone's share starts proportional to their nineum.
/// 2. The cap is the average share plus two standard deviations, worked out
///    over the people taking part.
/// 3. Anyone over the cap comes down to it, and what that frees up is shared
///    among everyone below it, again by nineum; anyone that pushes over the
///    cap comes down too, and so on until nobody is over.
/// 4. Shares round down to the cent. What's left (rounding, or everyone at
///    the cap) stays with the platform.
export const computePoolPayouts = (tally, members, proceedsCents, { poolPercent = POOL_PERCENT } = {}) => {
  const poolCents = Math.floor((proceedsCents * poolPercent) / 100);
  const people = Object.entries(tally)
    .filter(([pubKey, count]) => count > 0 && members[pubKey]?.payout)
    .map(([pubKey, count]) => ({ pubKey, payout: members[pubKey].payout, nineum: count }));
  const total = people.reduce((n, p) => n + p.nineum, 0);
  const result = { poolCents, nineum: total, capCents: null, payees: [], paidCents: 0, retainedCents: poolCents };
  if (!people.length || poolCents <= 0) return result;

  const raw = people.map((p) => (poolCents * p.nineum) / total);
  const mean = poolCents / people.length;
  const sd = Math.sqrt(raw.reduce((s, x) => s + (x - mean) ** 2, 0) / people.length);
  const cap = mean + 2 * sd;

  const share = [...raw];
  const atCap = new Set();
  for (;;) {
    let freed = 0;
    share.forEach((x, i) => {
      if (x > cap) {
        freed += x - cap;
        share[i] = cap;
        atCap.add(i);
      }
    });
    const below = share.map((_, i) => i).filter((i) => !atCap.has(i));
    if (freed <= 1e-9 || !below.length) break;
    const weight = below.reduce((n, i) => n + people[i].nineum, 0);
    for (const i of below) share[i] += (freed * people[i].nineum) / weight;
  }

  result.capCents = Math.floor(cap);
  result.payees = people
    .map((p, i) => ({ ...p, earnedCents: Math.floor(raw[i]), amountCents: Math.floor(share[i]), capped: atCap.has(i) }))
    .filter((p) => p.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents);
  result.paidCents = result.payees.reduce((n, p) => n + p.amountCents, 0);
  result.retainedCents = poolCents - result.paidCents;
  return result;
};
