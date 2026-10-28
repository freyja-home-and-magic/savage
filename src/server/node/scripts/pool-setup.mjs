// One-time setup of HomeVentory's Fount galaxy for the payment pool.
//
// The galaxy is what makes nineum worth paying on: only its owner (a key
// you hold) and the minters it names (savage) can mint in it. Fount's
// default galaxy, 28880014, is open to anyone and can't be used for this.
//
//   node scripts/pool-setup.mjs --new-owner-key
//       Makes the galaxy owner's keypair. Keep the private key off any
//       repo and off the server; it's only needed for the two steps below.
//
//   GALAXY_OWNER_PRIVATE_KEY=... GALAXY_OWNER_PUBLIC_KEY=... \
//   node scripts/pool-setup.mjs --fount https://prod.8as.world/fount/ --claim 48560001
//       Claims the galaxy (8 hex digits, unused) for the owner.
//
//   node scripts/pool-setup.mjs --fount https://prod.8as.world/fount/ --savage
//       Run on the savage server (same SAVAGE_DATA_DIR as savage): prints
//       savage's Fount uuid, making its Fount user if needed.
//
//   GALAXY_OWNER_...=... node scripts/pool-setup.mjs --fount ... --grant-minter <savage uuid>
//       Gives savage a Constellation (fe) nineum in the galaxy, so it can mint.
//
// Fount also has to be told the galaxy counts pay periods: set
// PERIOD_GALAXIES=<galaxy> in its environment and restart it.

import path from 'node:path';
import sessionless from 'sessionless-node';
import { createFountClient } from '../fount-client.js';

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

if (args.includes('--new-owner-key')) {
  let keys;
  await sessionless.generateKeys((k) => { keys = k; }, () => keys);
  console.log('GALAXY_OWNER_PUBLIC_KEY =', keys.pubKey);
  console.log('GALAXY_OWNER_PRIVATE_KEY =', keys.privateKey);
  console.log('\nKeep the private key safe and off the server: it controls who may mint.');
  process.exit(0);
}

const fountUrl = value('--fount') || process.env.FOUNT_URL;
if (!fountUrl) {
  console.error('Say which Fount: --fount https://prod.8as.world/fount/ (or FOUNT_URL)');
  process.exit(1);
}
const base = withSlash(fountUrl);

const send = async (route, method, body) => {
  const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) throw new Error(`${method} ${route}: ${out.error || `HTTP ${res.status}`}`);
  return out;
};

if (args.includes('--savage')) {
  const dataDir = process.env.SAVAGE_DATA_DIR ? path.join(process.env.SAVAGE_DATA_DIR, 'pool') : path.join(process.cwd(), 'data', 'pool');
  const me = await createFountClient({ fountUrl, keysFile: path.join(dataDir, 'fount-keys.json') }).self();
  console.log('savage Fount uuid:', me.uuid);
  process.exit(0);
}

const privateKey = process.env.GALAXY_OWNER_PRIVATE_KEY;
const pubKey = process.env.GALAXY_OWNER_PUBLIC_KEY;
if (!privateKey || !pubKey) {
  console.error('Set GALAXY_OWNER_PRIVATE_KEY and GALAXY_OWNER_PUBLIC_KEY (see --new-owner-key).');
  process.exit(1);
}
sessionless.getKeys = () => ({ privateKey, pubKey });
const now = () => `${Date.now()}`;

let timestamp = now();
const owner = await send('user/create', 'PUT', { timestamp, pubKey, signature: await sessionless.sign(timestamp + pubKey) });
console.log('Galaxy owner Fount uuid:', owner.uuid);

const galaxy = value('--claim');
if (galaxy) {
  if (!/^[0-9a-f]{8}$/.test(galaxy) || galaxy === '28880014') {
    console.error('A galaxy is 8 lowercase hex digits, and not the open 28880014.');
    process.exit(1);
  }
  timestamp = now();
  await send(`user/${owner.uuid}/nineum/galactic`, 'PUT', {
    timestamp, galaxy, signature: await sessionless.sign(timestamp + owner.uuid + galaxy),
  });
  console.log(`Claimed galaxy ${galaxy}. Set PERIOD_GALAXIES=${galaxy} on Fount and restart it.`);
}

const minter = value('--grant-minter');
if (minter) {
  timestamp = now();
  await send(`user/${owner.uuid}/nineum/admin`, 'PUT', {
    timestamp, toUserUUID: minter, signature: await sessionless.sign(timestamp + owner.uuid),
  });
  console.log(`${minter} can now mint in the owner's galaxy.`);
}
