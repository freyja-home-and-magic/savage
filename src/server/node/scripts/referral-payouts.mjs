// Monthly referral payouts. Run on the server that hosts savage, after the
// month ends and Apple's proceeds for it are known (App Store Connect,
// Payments and Financial Reports).
//
//   node scripts/referral-payouts.mjs --month 2026-10 --proceeds bizbuz=420.00 --proceeds linkitylink=80.00
//       Dry run: prints each payee's share and moves no money.
//
//   ... --pay
//       Pays them, through addie's /platform/payout, signed with the
//       platform admin key (PLATFORM_ADMIN_PRIVATE_KEY and _PUBLIC_KEY in
//       the environment; addie must have the same public key as
//       PLATFORM_ADMIN_PUBKEY). Results go to data/referrals/payouts-MONTH.json.
//       Safe to rerun: anyone already paid is skipped, and Stripe refuses a
//       repeat of the same idempotency key anyway.
//
//   node scripts/referral-payouts.mjs --new-admin-key
//       Makes a keypair for the above. Keep the private key off any repo.
//
// --proceeds is what Apple paid you for that app in that month, in dollars.
// 50% of it is shared by tap counts, capped at $50 a person (referrals.js).
// The platform's Stripe balance has to cover the total: this money came from
// Apple, not through Stripe, so top the balance up first.

import path from 'node:path';
import sessionless from 'sessionless-node';
import { computePayouts, createStore, POOL_PERCENT, CAP_CENTS } from '../referrals.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

const dollars = (c) => `$${(c / 100).toFixed(2)}`;

if (flag('--new-admin-key')) {
  let keys = null;
  await sessionless.generateKeys((k) => { keys = k; }, () => keys);
  console.log('PLATFORM_ADMIN_PUBKEY / PLATFORM_ADMIN_PUBLIC_KEY =', keys.pubKey);
  console.log('PLATFORM_ADMIN_PRIVATE_KEY =', keys.privateKey);
  console.log('\nPut the public key in addie\'s environment as PLATFORM_ADMIN_PUBKEY and restart it with --update-env.');
  console.log('Keep the private key with whoever runs payouts; never in a repo.');
  process.exit(0);
}

const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const month = values('--month')[0] || lastMonth();
const thisMonth = new Date().toISOString().slice(0, 7);
if (month >= thisMonth) {
  console.error(`${month} isn't over yet. Pay a month once it has ended.`);
  process.exit(1);
}

const proceedsCents = {};
for (const v of values('--proceeds')) {
  const [app, amount] = v.split('=');
  const cents = Math.round(Number(amount) * 100);
  if (!app || !Number.isFinite(cents) || cents < 0) {
    console.error(`Can't read --proceeds ${v}; use app=dollars, like bizbuz=420.00`);
    process.exit(1);
  }
  proceedsCents[app] = cents;
}
if (!Object.keys(proceedsCents).length) {
  console.error('Give each app\'s proceeds for the month: --proceeds bizbuz=420.00 --proceeds linkitylink=80.00');
  process.exit(1);
}

const dataDir = values('--data-dir')[0]
  || (process.env.SAVAGE_DATA_DIR ? path.join(process.env.SAVAGE_DATA_DIR, 'referrals') : path.join(process.cwd(), 'data', 'referrals'));
const store = createStore(dataDir);
const result = computePayouts(await store.taps(month), proceedsCents);

console.log(`Referral payouts for ${month}: ${POOL_PERCENT}% of proceeds, cap ${dollars(CAP_CENTS)} a person\n`);
for (const [app, p] of Object.entries(result.pools)) {
  console.log(`  ${app.padEnd(12)} proceeds ${dollars(p.proceedsCents).padStart(10)}  pool ${dollars(p.poolCents).padStart(10)}  taps ${p.taps}`);
}
console.log('');
for (const p of result.payees) {
  const capped = p.amountCents < p.earnedCents ? ` (earned ${dollars(p.earnedCents)}, capped)` : '';
  console.log(`  ${p.payout.pubKey.slice(0, 14)}…  ${String(p.taps).padStart(5)} taps  ${dollars(p.amountCents).padStart(9)}${capped}`);
}
console.log(`\n  Paying ${dollars(result.paidCents)} to ${result.payees.length} people; ${dollars(result.retainedCents)} of the pool stays with the platform.`);

if (!flag('--pay')) {
  console.log('\nDry run. Nothing was paid. Add --pay to send these.');
  process.exit(0);
}

// ── Paying ───────────────────────────────────────────────────────────────────

const privateKey = process.env.PLATFORM_ADMIN_PRIVATE_KEY;
const pubKey = process.env.PLATFORM_ADMIN_PUBLIC_KEY;
if (!privateKey || !pubKey) {
  console.error('\nSet PLATFORM_ADMIN_PRIVATE_KEY and PLATFORM_ADMIN_PUBLIC_KEY to pay (see --new-admin-key).');
  process.exit(1);
}
sessionless.getKeys = async () => ({ privateKey, pubKey });

// The addie address on a card is written by the card's owner, so only ever
// send signed payout requests to our own servers.
const allowedAddie = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === '8as.world' || u.hostname.endsWith('.8as.world'));
  } catch {
    return false;
  }
};

const ledger = (await store.payouts(month)) || { month, payees: [] };
ledger.proceedsCents = proceedsCents;
ledger.pools = result.pools;
for (const p of result.payees) {
  const existing = ledger.payees.find((e) => e.payout.pubKey === p.payout.pubKey && e.payout.addieURL === p.payout.addieURL);
  if (existing?.status === 'paid') {
    console.log(`  ${p.payout.pubKey.slice(0, 14)}…  already paid (${existing.transferId}), skipping`);
    continue;
  }
  const entry = { ...p, status: 'failed', error: null, transferId: null };
  if (!allowedAddie(p.payout.addieURL)) {
    entry.error = `addie ${p.payout.addieURL} is not one of ours`;
  } else {
    const idempotencyKey = `referral-${month}-${p.payout.pubKey}`;
    const timestamp = Date.now().toString();
    const body = { timestamp, payeePubKey: p.payout.pubKey, amount: p.amountCents, idempotencyKey, description: `HomeFront referral payout, ${month}` };
    body.signature = await sessionless.sign(`${timestamp}${p.payout.pubKey}${p.amountCents}${idempotencyKey}`);
    try {
      const url = new URL('platform/payout', p.payout.addieURL.endsWith('/') ? p.payout.addieURL : `${p.payout.addieURL}/`);
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.ok) {
        entry.status = 'paid';
        entry.transferId = out.transferId;
      } else {
        entry.error = out.error || `HTTP ${res.status}`;
      }
    } catch (err) {
      entry.error = err.message;
    }
  }
  entry.at = new Date().toISOString();
  ledger.payees = ledger.payees.filter((e) => !(e.payout.pubKey === p.payout.pubKey && e.payout.addieURL === p.payout.addieURL));
  ledger.payees.push(entry);
  await store.writePayouts(month, ledger);
  console.log(`  ${p.payout.pubKey.slice(0, 14)}…  ${entry.status === 'paid' ? `paid ${dollars(p.amountCents)} (${entry.transferId})` : `NOT paid: ${entry.error}`}`);
}
const failed = ledger.payees.filter((e) => e.status !== 'paid').length;
console.log(failed ? `\n${failed} payout(s) failed; fix the cause and run again with --pay.` : '\nAll paid.');
