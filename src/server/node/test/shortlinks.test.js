import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createShortLinkStore, parseShortPath, shortPath, slugify } from '../shortlinks.js';

const newStore = async () => createShortLinkStore(await mkdtemp(path.join(os.tmpdir(), 'savage-short-')));
const q = (sig) => ({ timestamp: '1', hash: 'linkitylink-card', signature: sig });

test('names become link-safe slugs', () => {
  assert.equal(slugify('Jane Doe'), 'jane-doe');
  assert.equal(slugify("  Zoë O'Brien!! "), 'zoë-o-brien');
  assert.equal(slugify('山田 太郎'), '山田-太郎');
  assert.equal(slugify('DJ  ---  Snake'), 'dj-snake');
  assert.equal(slugify(''), 'card');
  assert.equal(slugify('!!!'), 'card');
  assert.equal(slugify(undefined), 'card');
  assert.ok(slugify('a'.repeat(200)).length <= 64);
});

test('first come gets the bare name, the next get /2/, /3/', async () => {
  const store = await newStore();
  assert.equal((await store.claim('u1', 'Jane Doe', q('a'))).path, 'jane-doe');
  assert.equal((await store.claim('u2', 'jane doe', q('b'))).path, '2/jane-doe');
  assert.equal((await store.claim('u3', 'JANE DOE', q('c'))).path, '3/jane-doe');
});

test('a card keeps its place when republished', async () => {
  const store = await newStore();
  await store.claim('u1', 'Jane', q('a'));
  await store.claim('u2', 'Jane', q('b'));
  assert.equal((await store.claim('u2', 'Jane', q('b2'))).path, '2/jane');
  assert.deepEqual(await store.lookup('jane', 2), { uuid: 'u2', query: q('b2') }, 'keeps the latest signed query');
});

test('renaming adds a link and keeps the old one', async () => {
  const store = await newStore();
  await store.claim('u1', 'Jane', q('a'));
  assert.equal((await store.claim('u1', 'Jane Smith', q('a2'))).path, 'jane-smith');
  assert.equal((await store.lookup('jane', 1)).uuid, 'u1');
  assert.equal((await store.lookup('jane-smith', 1)).uuid, 'u1');
});

test('lookups that miss', async () => {
  const store = await newStore();
  await store.claim('u1', 'Jane', q('a'));
  assert.equal(await store.lookup('jane', 2), null);
  assert.equal(await store.lookup('john', 1), null);
});

test('concurrent claims on one name all get distinct places', async () => {
  const store = await newStore();
  const paths = await Promise.all(Array.from({ length: 10 }, (_, i) => store.claim(`u${i}`, 'Sam', q(`${i}`)).then((r) => r.path)));
  assert.equal(new Set(paths).size, 10);
  assert.ok(paths.includes('sam') && paths.includes('10/sam'));
});

test('short paths read back, and nothing else does', () => {
  assert.deepEqual(parseShortPath('jane-doe'), { slug: 'jane-doe', ordinal: 1 });
  assert.deepEqual(parseShortPath('2', 'jane-doe'), { slug: 'jane-doe', ordinal: 2 });
  assert.deepEqual(parseShortPath('Jane-Doe'), { slug: 'jane-doe', ordinal: 1 }, 'typed with capitals');
  assert.deepEqual(parseShortPath('2', 'Jane Doe'), { slug: 'jane-doe', ordinal: 2 });
  assert.equal(parseShortPath('0', 'jane'), null);
  assert.equal(parseShortPath('x', 'jane'), null);
  assert.equal(shortPath('zoë', 1), 'zo%C3%AB');
  assert.equal(shortPath('zoë', 2), '2/zo%C3%AB');
});

test('an owner\'s new card takes back the link of their deleted one', async () => {
  const store = await newStore();
  const gone = new Set();
  const isGone = async (uuid) => gone.has(uuid);
  await store.claim('u1', 'Jane', q('a'), { owner: 'alice', isGone });
  await store.claim('u2', 'Jane', q('b'), { owner: 'bob', isGone });
  gone.add('u1');
  assert.equal((await store.claim('u3', 'Jane', q('c'), { owner: 'alice', isGone })).path, 'jane');
  assert.deepEqual(await store.lookup('jane', 1), { uuid: 'u3', query: q('c') });
  assert.equal((await store.lookup('jane', 2)).uuid, 'u2', 'bob keeps his');
});

test('nobody else gets a deleted card\'s link', async () => {
  const store = await newStore();
  const isGone = async (uuid) => uuid === 'u1';
  await store.claim('u1', 'Jane', q('a'), { owner: 'alice', isGone });
  assert.equal((await store.claim('u2', 'Jane', q('b'), { owner: 'bob', isGone })).path, '2/jane');
  assert.equal((await store.claim('u3', 'Jane', q('c'), { isGone })).path, '3/jane', 'no owner, no reuse');
  assert.equal((await store.lookup('jane', 1)).uuid, 'u1');
});

test('an owner\'s two live cards with one name keep a link each', async () => {
  const store = await newStore();
  const isGone = async () => false;
  await store.claim('u1', 'Jane', q('a'), { owner: 'alice', isGone });
  assert.equal((await store.claim('u2', 'Jane', q('b'), { owner: 'alice', isGone })).path, '2/jane');
  assert.equal((await store.lookup('jane', 1)).uuid, 'u1');
});
