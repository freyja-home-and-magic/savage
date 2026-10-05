import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computePayouts, createStore, getAppCta, isBot, tapCount, visitorKey, REFERRAL_APPS } from '../referrals.js';

const alice = { pubKey: '02alice', addieURL: 'https://prod.8as.world/addie/' };
const bob = { pubKey: '02bob', addieURL: 'https://prod.8as.world/addie/' };
const card = (app, payout, n, date = '2026-10-01') => ({ app, payout, days: { [date]: Array.from({ length: n }, (_, i) => `v${i}`) } });

test('link-preview bots and scripts never count', () => {
  for (const ua of [
    'facebookexternalhit/1.1 Facebot Twitterbot/1.0', // iMessage previews
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'WhatsApp/2.23.20.0',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0)',
    'curl/8.4.0',
    '',
    undefined,
  ]) {
    assert.ok(isBot(ua), `${ua} should be a bot`);
  }
  assert.ok(!isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'));
});

test('visitor keys are stable within a day and never the raw IP', () => {
  const a = visitorKey('salt', '203.0.113.9', 'UA', 'card', '2026-10-01');
  assert.equal(a, visitorKey('salt', '203.0.113.9', 'UA', 'card', '2026-10-01'));
  assert.notEqual(a, visitorKey('salt', '203.0.113.9', 'UA', 'card', '2026-10-02'));
  assert.ok(!a.includes('203'));
});

test('redirects only to the two App Store listings', () => {
  assert.deepEqual([...new Set(Object.values(REFERRAL_APPS).map((a) => a.storeUrl))], [
    'https://apps.apple.com/app/id6808065888',
    'https://apps.apple.com/app/id6808065892',
  ]);
});

test('"make your own" only on ordinary cards, and only when switched on', () => {
  assert.deepEqual(getAppCta('bizbuz-card', '/r/x', true), { label: 'Make your own card with BizBuz', href: '/r/x' });
  assert.equal(getAppCta('linkitylink-card', '/r/x', true).label, 'Make your own link page with Linkitylink');
  assert.equal(getAppCta('bizbuz-card', '/r/x', false), null, 'off unless SAVAGE_GET_APP_CTA=on');
  assert.equal(getAppCta('bizbuz-referral', '/r/x', true), null, 'an invite card is already the button');
  assert.equal(getAppCta('someone-elses-hash', '/r/x', true), null);
});

test('card taps and invite taps share one person\'s cap', () => {
  const taps = {
    invite: { app: 'bizbuz', payout: alice, days: { '2026-10-01': ['a', 'b'] } },
    card: { app: 'bizbuz', payout: alice, days: { '2026-10-01': ['c', 'd', 'e'] } },
    other: { app: 'bizbuz', payout: bob, days: { '2026-10-01': ['f', 'g', 'h', 'i', 'j'] } },
  };
  const r = computePayouts(taps, { bizbuz: 4_000 }); // $20 pool, 10 taps
  const byKey = Object.fromEntries(r.payees.map((p) => [p.payout.pubKey, p]));
  assert.equal(byKey['02alice'].taps, 5);
  assert.deepEqual(byKey['02alice'].cards.sort(), ['card', 'invite']);
  assert.equal(byKey['02alice'].amountCents, 1_000);
});

test('one tap per visitor per card per day', async () => {
  const store = createStore(await mkdtemp(path.join(os.tmpdir(), 'savage-ref-')));
  const tap = (visitor, date) => store.recordTap({ uuid: 'c1', app: 'bizbuz', payout: alice, visitor, date });
  assert.equal(await tap('v1', '2026-10-01'), true);
  assert.equal(await tap('v1', '2026-10-01'), false, 'same visitor, same day');
  assert.equal(await tap('v1', '2026-10-02'), true, 'next day counts again');
  assert.equal(await tap('v2', '2026-10-02'), true);
  const taps = await store.taps('2026-10');
  assert.equal(tapCount(taps.c1), 3);
  assert.deepEqual(taps.c1.payout, alice);
  assert.deepEqual(await store.months(), ['2026-10']);
});

test('concurrent taps are all kept', async () => {
  const store = createStore(await mkdtemp(path.join(os.tmpdir(), 'savage-ref-')));
  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    store.recordTap({ uuid: 'c1', app: 'bizbuz', payout: alice, visitor: `v${i}`, date: '2026-10-01' })));
  assert.equal(tapCount((await store.taps('2026-10')).c1), 25);
});

test('half of each app\'s proceeds, shared by taps', () => {
  const taps = { a: card('bizbuz', alice, 30), b: card('bizbuz', bob, 10) };
  const r = computePayouts(taps, { bizbuz: 10_000 });
  assert.equal(r.pools.bizbuz.poolCents, 5_000);
  assert.deepEqual(r.payees.map((p) => [p.payout.pubKey, p.amountCents]), [['02alice', 3_750], ['02bob', 1_250]]);
  assert.equal(r.retainedCents, 0);
});

test('capped at $50 a person, the rest retained', () => {
  const taps = { a: card('bizbuz', alice, 90), b: card('bizbuz', bob, 10) };
  const r = computePayouts(taps, { bizbuz: 200_000 }); // $1,000 pool
  const byKey = Object.fromEntries(r.payees.map((p) => [p.payout.pubKey, p]));
  assert.equal(byKey['02alice'].earnedCents, 90_000);
  assert.equal(byKey['02alice'].amountCents, 5_000);
  assert.equal(byKey['02bob'].amountCents, 5_000);
  assert.equal(r.retainedCents, 100_000 - 10_000);
});

test('one person\'s cards across both apps share one cap', () => {
  const taps = { a: card('bizbuz', alice, 10), b: card('linkitylink', alice, 10) };
  const r = computePayouts(taps, { bizbuz: 8_000, linkitylink: 8_000 });
  assert.equal(r.payees.length, 1);
  assert.equal(r.payees[0].earnedCents, 8_000);
  assert.equal(r.payees[0].amountCents, 5_000);
});

test('unconnected cards earn nothing, and don\'t dilute the connected', () => {
  const taps = { a: card('bizbuz', alice, 10), b: card('bizbuz', null, 1000) };
  const r = computePayouts(taps, { bizbuz: 2_000 });
  assert.deepEqual(r.payees.map((p) => p.amountCents), [1_000]);
});

test('never pays more than the pool', () => {
  const taps = { a: card('bizbuz', alice, 1), b: card('bizbuz', bob, 1), c: card('bizbuz', { pubKey: '02c', addieURL: 'x' }, 1) };
  const r = computePayouts(taps, { bizbuz: 1_000 }); // 500 split three ways
  assert.ok(r.paidCents <= 500);
  assert.equal(r.paidCents + r.retainedCents, 500);
});

test('no taps or no proceeds: nothing paid', () => {
  assert.equal(computePayouts({}, { bizbuz: 10_000 }).paidCents, 0);
  assert.equal(computePayouts({ a: card('bizbuz', alice, 5) }, { bizbuz: 0 }).paidCents, 0);
});
