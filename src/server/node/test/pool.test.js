import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computePoolPayouts, createPoolStore, cardMember } from '../pool.js';

const key = (n) => `02${String(n).padStart(64, '0')}`;
const destination = (n) => ({ pubKey: key(1000 + n), addieURL: 'https://prod.8as.world/addie/' });
const membersFor = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [key(i), { uuid: `u${i}`, payout: destination(i) }]));
const newStore = async () => createPoolStore(await mkdtemp(path.join(os.tmpdir(), 'savage-pool-')));

test('a card names its owner only with a well-formed pubKey', () => {
  assert.equal(cardMember({ fount: { pubKey: key(1).toUpperCase().replace('0X', '0x') } }), key(1));
  assert.equal(cardMember({ fount: { pubKey: 'nope' } }), null);
  assert.equal(cardMember({}), null);
});

test('each action counts once per dedupe key', async () => {
  const store = await newStore();
  const base = { action: 'view', member: key(1), card: 'c1', app: 'bizbuz', date: '2026-10-05' };
  assert.equal(await store.record({ ...base, dedupe: 'view|c1|v1|2026-10-05' }), true);
  assert.equal(await store.record({ ...base, dedupe: 'view|c1|v1|2026-10-05' }), false);
  assert.equal(await store.record({ ...base, dedupe: 'view|c1|v2|2026-10-05' }), true);
  assert.deepEqual(await store.cardActivity('c1', '2026-10'), { tap: 0, view: 2, share: 0, purchase: 0 });
});

test('a month pays on the nineum minted in it', async () => {
  const store = await newStore();
  for (let i = 0; i < 3; i++) {
    await store.record({ action: 'tap', member: key(1), card: 'c', dedupe: `t${i}`, date: '2026-10-31' });
  }
  const pending = await store.ungranted();
  // Two minted on the 31st, one after midnight: it pays in November.
  await store.markGranted('2026-10', pending['2026-10'].idx.slice(0, 2), '2026-10');
  await store.markGranted('2026-10', pending['2026-10'].idx.slice(2), '2026-11');
  assert.deepEqual(await store.tally('2026-10'), { [key(1)]: 2 });
  assert.deepEqual(await store.tally('2026-11'), { [key(1)]: 1 });
  assert.deepEqual(await store.ungranted(), {});
});

test('registering keeps the payout destination unless a new one is given', async () => {
  const store = await newStore();
  await store.register(key(1), 'u1', destination(1));
  await store.register(key(1), 'u1');
  assert.deepEqual((await store.members())[key(1)].payout, destination(1));
});

test('shares follow nineum when nobody is far above the rest', () => {
  const r = computePoolPayouts({ [key(0)]: 30, [key(1)]: 10 }, membersFor(2), 10_000); // $50 pool
  assert.equal(r.poolCents, 5_000);
  assert.deepEqual(r.payees.map((p) => p.amountCents), [3_750, 1_250]);
  assert.ok(r.payees.every((p) => !p.capped));
  assert.equal(r.retainedCents, 0);
});

test('an outlier is capped at two standard deviations, and the rest share what that frees', () => {
  // 20 people with 10 nineum each, and one with 1000.
  const tally = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [key(i), i === 20 ? 1000 : 10]));
  const r = computePoolPayouts(tally, membersFor(21), 200_000); // $1,000 pool
  const top = r.payees.find((p) => p.pubKey === key(20));
  assert.ok(top.capped);
  assert.equal(top.amountCents, r.capCents);
  assert.ok(top.amountCents < top.earnedCents);
  const others = r.payees.filter((p) => p.pubKey !== key(20));
  assert.equal(new Set(others.map((p) => p.amountCents)).size, 1, 'the rest share equally, as their nineum are equal');
  assert.ok(others[0].amountCents > others[0].earnedCents, 'and each gets more than their raw share');
  assert.ok(r.payees.every((p) => p.amountCents <= r.capCents));
  assert.ok(r.paidCents <= r.poolCents && r.poolCents - r.paidCents < r.payees.length, 'only rounding is left over');
});

test('only people with a payout destination take part', () => {
  const members = membersFor(2);
  delete members[key(1)].payout;
  const r = computePoolPayouts({ [key(0)]: 5, [key(1)]: 5 }, members, 10_000);
  assert.deepEqual(r.payees.map((p) => p.pubKey), [key(0)]);
  assert.equal(r.paidCents, 5_000);
});

test('no nineum or no proceeds, no payouts', () => {
  assert.equal(computePoolPayouts({}, membersFor(1), 10_000).paidCents, 0);
  assert.equal(computePoolPayouts({ [key(0)]: 5 }, membersFor(1), 0).paidCents, 0);
});
