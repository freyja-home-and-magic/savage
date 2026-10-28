// savage's side of Fount, for the payment pool (pool.js).
//
// savage has its own Fount user, with a keypair it makes on first use and
// keeps in SAVAGE_DATA_DIR/pool/fount-keys.json (mode 600, never in a
// repo). To mint, that user needs a Constellation (fe) nineum in
// HomeVentory's galaxy, granted once by whoever holds the galaxy: see
// scripts/pool-setup.mjs. Everything savage mints then lands in that galaxy.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import sessionless from 'sessionless-node';
import { ACTIONS } from './pool.js';

const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

const call = async (url, method, body) => {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  // Fount's freshness check answers 200 with an error field.
  if (!res.ok || out.error) {
    throw new Error(`fount ${method} ${new URL(url).pathname}: ${out.error || `HTTP ${res.status}`}`);
  }
  return out;
};

export const createFountClient = ({ fountUrl, keysFile }) => {
  const base = withSlash(fountUrl);
  let keys = null;
  let uuid = null;

  const loadKeys = async () => {
    if (keys) return keys;
    try {
      keys = JSON.parse(await fs.readFile(keysFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await sessionless.generateKeys((k) => { keys = k; }, () => keys);
      await fs.mkdir(path.dirname(keysFile), { recursive: true });
      await fs.writeFile(keysFile, JSON.stringify(keys), { mode: 0o600 });
    }
    return keys;
  };
  const sign = async (message) => {
    const k = await loadKeys();
    sessionless.getKeys = () => k;
    return sessionless.sign(message);
  };

  /// savage's own Fount user: { uuid, pubKey }.
  const self = async () => {
    const k = await loadKeys();
    if (!uuid) {
      const timestamp = `${Date.now()}`;
      const user = await call(`${base}user/create`, 'PUT', {
        timestamp, pubKey: k.pubKey, signature: await sign(timestamp + k.pubKey),
      });
      uuid = user.uuid;
    }
    return { uuid, pubKey: k.pubKey };
  };

  return {
    self,

    /// Passes a member's own signed create request to Fount and returns
    /// their uuid. Fount only answers with the uuid of the pubKey that
    /// signed, so this is the proof of who owns it.
    createMember: async ({ pubKey, timestamp, signature }) => {
      const user = await call(`${base}user/create`, 'PUT', { pubKey, timestamp, signature });
      if (!user.uuid || user.pubKey?.toLowerCase() !== pubKey.toLowerCase()) {
        throw new Error('fount answered for a different key');
      }
      return user.uuid;
    },

    /// Mints `quantity` nineum for `action` to a Fount user. Charge and
    /// rarity are fixed, the direction says which action earned them, and
    /// size, texture and shape are random: the spec's "element of
    /// randomness", which the pool itself ignores.
    grant: async (toUUID, action, quantity) => {
      const me = await self();
      const pick = () => `0${randomInt(1, 6)}`;
      const flavor = { charge: '01', direction: ACTIONS[action], rarity: '01', size: pick(), texture: pick(), shape: pick() };
      const timestamp = `${Date.now()}`;
      const message = timestamp + me.uuid + toUUID + Object.values(flavor).join('') + quantity;
      await call(`${base}user/${me.uuid}/nineum`, 'PUT', {
        timestamp, toUserUUID: toUUID, ...flavor, quantity, signature: await sign(message),
      });
    },
  };
};
