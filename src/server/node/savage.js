import express from 'express';
// removeJavaScript isn't exported from teleportation-js's main entry (that's
// safeTeleportationParser, a different feature - parsing signed <teleport>
// tags out of a fetched page). It's the internal helper that actually strips
// <script>/<noscript> tags, javascript:/data: URLs, CSS expression()
// injections, and on* event handler attributes - which is what a BDO's svg
// property (arbitrary content from whoever had a valid signature to write
// it) needs before being served back as live, browser-rendered markup.
import removeJavaScript from 'teleportation-js/src/node-remove-javascript.js';
import path from 'node:path';
import sessionless from 'sessionless-node';
import { REFERRAL_APPS, getAppCta, isBot, visitorKey } from './referrals.js';
import { createPoolStore, cardMember, isPubKey, monthOf } from './pool.js';
import { createFountClient } from './fount-client.js';
import { SHORT_LINK_HASH, createShortLinkStore, parseShortPath } from './shortlinks.js';
// Node 18+ has a native global fetch - no need for the node-fetch package.

const app = express();

// Every path below builds URLs as `${BDO_URL}user/...`, so the base must end
// in a slash — an env var set without one is the obvious footgun, so
// normalize rather than silently producing `.../bdouser/...`.
const withTrailingSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

// BDO_URL is the one to set in deployment — savage runs alongside BDO on the
// droplet, so http://127.0.0.1:3003/ there. The LOCALHOST shorthand and the
// <subdomain>.bdo.allyabase.com fallback below predate it and are kept only
// so older single-box setups keep working unchanged.
const SUBDOMAIN = process.env.SUBDOMAIN || 'dev';
const BDO_URL = withTrailingSlash(
  process.env.BDO_URL
    || (process.env.LOCALHOST
      ? 'http://127.0.0.1:3003/'
      : `https://${SUBDOMAIN}.bdo.allyabase.com/`)
);

// The HTML page savage serves embeds absolute URLs back to itself (og:image
// pointing at .../svg, the "Save Contact" link pointing at .../vcard), so it
// has to know how it was reached from outside - which a reverse proxy hides.
//
// Behind nginx path-based routing (`location /savage/ { proxy_pass
// http://localhost:3012/; }`) the trailing slash on proxy_pass strips the
// /savage prefix before savage sees the request, so req.path has no prefix
// and req.get('host') is whatever nginx forwarded. nginx must therefore send
// the prefix explicitly:
//
//     location /savage/ {
//         proxy_pass http://localhost:3012/;
//         proxy_set_header X-Forwarded-Prefix /savage;
//     }
//
// PUBLIC_PREFIX is the fallback for when it doesn't (the stock allyabase
// nginx config sets Host/X-Forwarded-Proto but not the prefix) - set
// PUBLIC_PREFIX=/savage and the links come out right either way. A direct,
// unproxied deployment needs neither: there's no prefix, and host/protocol
// are already real.
//
// Forwarded headers are comma-appended across proxy hops rather than
// overwritten, so a value can arrive as "https,https". The first entry is
// always the original client-facing one, so that's the one to keep.
const PUBLIC_PREFIX = process.env.PUBLIC_PREFIX || '';

const firstForwarded = (value) => value ? value.split(',')[0].trim() : null;

const absoluteUrl = (req, path) => {
  const host = firstForwarded(req.get('x-forwarded-host')) || req.get('host');
  const proto = firstForwarded(req.get('x-forwarded-proto')) || req.protocol;
  const prefix = firstForwarded(req.get('x-forwarded-prefix')) || PUBLIC_PREFIX;
  return `${proto}://${host}${prefix}${path}`;
};

// The page chrome around a card used to be hardcoded to one app's colours
// (#111 ground, #10b981 button — BizBuz's palette before it was rethemed).
// savage serves cards from every app that publishes an svg, so baking in any
// single app's palette is wrong regardless of whether the values are current.
//
// A publisher can now send `palette` on the BDO alongside `svg` and `vcard`,
// and the page picks it up. These defaults reproduce the old appearance
// exactly, so records published before this change render unchanged.
const DEFAULT_PALETTE = {
  background: '#111',
  accent: '#10b981',
  accentText: '#111',
};

// Palette values are untrusted — they arrive on a BDO written by whoever held
// the signature, exactly like the svg does, and they get interpolated into a
// style attribute. A value such as `#111;background-image:url(...)` or one
// carrying a quote would break out of the attribute and inject arbitrary CSS
// into a page savage otherwise guarantees is script-free.
//
// So: only literal hex colours, nothing else. Anything that doesn't match
// falls back rather than being escaped and passed through, because there is
// no legitimate reason for a colour to be anything but a hex value here.
// Text pulled off a BDO record and interpolated into this page. The svg goes
// through sanitizeSvg, but until 2026-10 the title did not go through
// anything: `<title>${title}</title>` took the record's title field raw, so a
// crafted record carrying `</title><script>...` executed on a page whose
// entire promise is that it is script-free. The og tags below land in
// attributes, which are easier still to break out of, so everything
// interpolated as text is escaped from here on.
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const safeColor = (value, fallback) =>
  typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim() : fallback;

const resolvePalette = (palette) => {
  const p = (palette && typeof palette === 'object') ? palette : {};
  return {
    background: safeColor(p.background, DEFAULT_PALETTE.background),
    accent: safeColor(p.accent, DEFAULT_PALETTE.accent),
    accentText: safeColor(p.accentText, DEFAULT_PALETTE.accentText),
  };
};

const wrapHTML = (svg, imageUrl, title, vcardUrl, palette, description, cta) => {
  const { background, accent, accentText } = resolvePalette(palette);
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<meta property="og:type" content="profile">
<meta property="og:site_name" content="HomeFront">
<meta property="og:title" content="${safeTitle}">
<meta name="twitter:title" content="${safeTitle}">
${safeDescription ? `<meta name="description" content="${safeDescription}">
<meta property="og:description" content="${safeDescription}">
<meta name="twitter:description" content="${safeDescription}">` : ''}
<meta property="og:image" content="${imageUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${imageUrl}">
</head>
<body style="margin:0; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; background:${background}; gap:20px;">
${svg}
${vcardUrl ? `<a href="${vcardUrl}" style="font-family:sans-serif; font-size:15px; font-weight:bold; padding:12px 28px; background:${accent}; color:${accentText}; border-radius:8px; text-decoration:none;">Save Contact</a>` : ''}
${cta ? `<a href="${escapeHtml(cta.href)}" style="font-family:sans-serif; font-size:14px; font-weight:bold; padding:10px 24px; border:2px solid ${accent}; color:${accent}; border-radius:8px; text-decoration:none;">${escapeHtml(cta.label)}</a>` : ''}
</body>
</html>`;
};

// An embedded raster image, as every card with a photo carries.
//
// removeJavaScript deletes any element whose href/src/data starts with
// `data:` — the whole element, not just the attribute — because a data URL
// can smuggle script. That is right for data:text/html and
// data:image/svg+xml (an SVG document can carry <script>), but it also ate
// the avatar out of every published card: the apps have no image host, so a
// photo is base64'd straight into the card's <image href>.
//
// So safe raster URIs are carried across the sanitizer under a placeholder
// and restored afterwards. The library's protection is untouched: the only
// data: URI in the output is one that matched this pattern, and it is put
// back only on an <image> element. Raster mime types only, never svg+xml.
const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const PLACEHOLDER_PREFIX = 'savage-safe-image:';

// JSDOM parses its input as a full document even when it's just an <svg>
// fragment, wrapping it in <html><head></head><body>...</body></html> - so
// after stripping, pull the sanitized <svg> element back out rather than
// returning the whole wrapper document.
const sanitizeSvg = (rawSvg) => {
  // Stash before sanitizing, since removeJavaScript removes the element and
  // nothing can be recovered from the DOM afterwards.
  const stashed = [];
  const withPlaceholders = rawSvg.replace(
    /(\s(?:xlink:href|href)\s*=\s*")(data:[^"]*)(")/gi,
    (whole, before, value, after) => {
      if (!SAFE_IMAGE_DATA_URI.test(value.trim())) return whole;
      stashed.push(value);
      return `${before}${PLACEHOLDER_PREFIX}${stashed.length - 1}${after}`;
    }
  );

  const dom = removeJavaScript(withPlaceholders);
  const svgEl = dom.window.document.querySelector('svg');
  if (!svgEl) return null;

  for (const attr of ['href', 'xlink:href']) {
    for (const el of svgEl.querySelectorAll(`[${attr.replace(':', '\\:')}]`)) {
      const value = el.getAttribute(attr) || '';
      if (!value.startsWith(PLACEHOLDER_PREFIX)) continue;

      const original = stashed[Number(value.slice(PLACEHOLDER_PREFIX.length))];
      // Only an <image> gets a data URI back. A crafted card could have put
      // the placeholder on something else; that just loses the attribute.
      if (original && el.tagName.toLowerCase() === 'image') {
        el.setAttribute(attr, original);
      } else {
        el.removeAttribute(attr);
      }
    }
  }

  return svgEl.outerHTML;
};

// Forwards whatever it's given straight through to BDO's own auth (the
// query string - timestamp/hash/signature/pubKey/emojicode - is exactly
// what GET /user/:uuid/bdo already expects), sanitizes the svg property
// (this is untrusted content - anyone with a valid signature for a given
// uuid can have written it), and returns the parsed bdo object.
const fetchBdo = async (uuid, query) => {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${BDO_URL}user/${uuid}/bdo${qs ? `?${qs}` : ''}`);

  if (!res.ok) {
    return { error: true, status: res.status, body: await res.text() };
  }

  const { bdo } = await res.json();

  if (bdo && bdo.svg) {
    bdo.svg = sanitizeSvg(bdo.svg);
  }

  return { error: false, bdo };
};

app.get('/user/:uuid/bdo/svg', async (req, res) => {
  const result = await fetchBdo(req.params.uuid, req.query);

  if (result.error) {
    return res.status(result.status).send(result.body);
  }

  if (!result.bdo || !result.bdo.svg) {
    return res.status(404).send('No svg property on this BDO');
  }

  res.set('Content-Type', 'image/svg+xml');
  res.send(result.bdo.svg);
});

// vCard text is plain contact data, not markup - it's served with
// Content-Type: text/vcard so browsers download it rather than render or
// execute it, so unlike bdo.svg it needs no sanitization pass.
app.get('/user/:uuid/bdo/vcard', async (req, res) => {
  const result = await fetchBdo(req.params.uuid, req.query);

  if (result.error) {
    return res.status(result.status).send(result.body);
  }

  if (!result.bdo || !result.bdo.vcard) {
    return res.status(404).send('No vcard property on this BDO');
  }

  const name = (result.bdo.name || result.bdo.title || 'contact').replace(/[^a-zA-Z0-9.-]/g, '_');
  res.set('Content-Type', 'text/vcard; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}.vcf"`);
  res.send(result.bdo.vcard);
});

app.get('/user/:uuid/bdo', async (req, res) => {
  try {
    const result = await fetchBdo(req.params.uuid, req.query);

    if (result.error) {
      return res.status(result.status).send(result.body);
    }

    if (!result.bdo || !result.bdo.svg) {
      return res.status(404).send('No svg property on this BDO');
    }

    const qs = new URLSearchParams(req.query).toString();
    const imageUrl = absoluteUrl(req, `/user/${req.params.uuid}/bdo/svg${qs ? `?${qs}` : ''}`);
    const vcardUrl = result.bdo.vcard
      ? absoluteUrl(req, `/user/${req.params.uuid}/bdo/vcard${qs ? `?${qs}` : ''}`)
      : null;
    // `title` on a BizBuz record is the person's JOB title ("Software
    // Enchantress"), not a page title, so name wins. This used to read
    // `title || name`, which titled every BizBuz card's page and link
    // preview with the job rather than the person.
    const title = result.bdo.name || result.bdo.title || 'savage';

    // One line of context for the link preview, assembled from whatever the
    // publishing app happened to put on the record. BizBuz cards carry a job
    // title and company; Linkitylink cards carry a bio and a list of links;
    // the referral cards carry neither and correctly get no description, in
    // which case wrapHTML omits the tags rather than emitting empty ones.
    const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
    const role = [
      // Skip the job title if it is already serving as the page title, which
      // happens on a record with no name.
      result.bdo.name ? text(result.bdo.title) : '',
      text(result.bdo.company),
    ].filter(Boolean).join(' at ');
    const linkCount = Array.isArray(result.bdo.links) ? result.bdo.links.length : 0;
    let description = [role, text(result.bdo.bio)].filter(Boolean).join(' \u00b7 ');
    if (!description && linkCount) {
      description = `${linkCount} link${linkCount === 1 ? '' : 's'}`;
    }
    if (description.length > 160) {
      description = `${description.slice(0, 159)}\u2026`;
    }

    // "Make your own" on BizBuz and Linkitylink cards, through the tap
    // counter so a tap credits the card's owner (see referrals.js).
    const cta = getAppCta(
      req.query.hash,
      absoluteUrl(req, `/r/${req.params.uuid}${qs ? `?${qs}` : ''}`),
      process.env.SAVAGE_GET_APP_CTA === 'on'
    );

    res.set('Content-Type', 'text/html');
    // palette is optional and validated in wrapHTML; a record without one
    // renders exactly as it did before palettes existed.
    res.send(wrapHTML(result.bdo.svg, imageUrl, title, vcardUrl, result.bdo.palette, description, cta));

    // A view of a BizBuz or Linkitylink card earns its owner a nineum (see
    // pool.js). After the response, so counting never slows a page.
    if (REFERRAL_APPS[req.query.hash]?.kind === 'card') {
      countVisit('view', req, req.params.uuid, result.bdo, REFERRAL_APPS[req.query.hash].app)
        .catch((err) => console.warn('view not counted:', err.message));
    }
  } catch (err) {
    console.warn('savage error:', err);
    res.status(500).send('Internal error');
  }
});

// ── Payment pool ────────────────────────────────────────────────────────────
//
// See pool.js for what earns and how it pays. Data in SAVAGE_DATA_DIR/pool
// (default ./data/pool): back it up, it's the record of who is owed what.
// FOUNT_URL (e.g. http://127.0.0.1:3006/) turns on minting; without it
// actions are recorded and minted once it's set.
const poolDir = process.env.SAVAGE_DATA_DIR
  ? path.join(process.env.SAVAGE_DATA_DIR, 'pool')
  : path.join(process.cwd(), 'data', 'pool');
const pool = createPoolStore(poolDir);
const fount = process.env.FOUNT_URL
  ? createFountClient({ fountUrl: process.env.FOUNT_URL, keysFile: path.join(poolDir, 'fount-keys.json') })
  : null;

// The visitor's address as nginx saw it. X-Real-IP is set (overwritten) by
// our nginx from the connection itself; X-Forwarded-For can't be trusted
// for this, because a client can send its own and nginx appends to it, so
// its FIRST entry is whatever the client claimed. Failing X-Real-IP, the
// LAST entry is the one nginx added.
const clientIp = (req) => {
  const real = req.get('x-real-ip');
  if (real) return real.trim();
  const chain = (req.get('x-forwarded-for') || '').split(',').map((v) => v.trim()).filter(Boolean);
  return chain[chain.length - 1] || req.socket.remoteAddress || '';
};
const today = () => new Date().toISOString().slice(0, 10);

// A tap or a view: once per visitor per card per day, never a bot, and
// only for a card that names its owner.
const countVisit = async (action, req, uuid, bdo, app) => {
  const ua = req.get('user-agent');
  const member = cardMember(bdo);
  if (isBot(ua) || !member) return false;
  const date = today();
  const visitor = visitorKey(await pool.salt(), clientIp(req), ua, uuid, date);
  return pool.record({ action, member, card: uuid, app, dedupe: `${action}|${uuid}|${visitor}|${date}`, date });
};

// A signature over `message` by `pubKey`, made in the last 5 minutes.
const freshlySigned = (timestamp, signature, message, pubKey) => {
  const age = Math.abs(Date.now() - Number(timestamp));
  if (!(age <= 5 * 60 * 1000) || typeof signature !== 'string') return false;
  try {
    return sessionless.verifySignature(signature, message, pubKey);
  } catch {
    return false;
  }
};

// An invite card's "Get" button, and a card's "Make your own", point here
// with the card's own signed query. savage counts the tap and sends the
// visitor on to the App Store. The redirect target comes from
// REFERRAL_APPS, never from the request, and a tap that can't be verified
// still gets its redirect, it just isn't counted.
app.get('/r/:uuid', async (req, res) => {
  const referral = REFERRAL_APPS[req.query.hash];
  if (!referral) {
    return res.status(404).send('Not an invite link');
  }
  res.set('Cache-Control', 'no-store');
  try {
    if (!isBot(req.get('user-agent'))) {
      const result = await fetchBdo(req.params.uuid, req.query);
      if (!result.error && result.bdo) {
        await countVisit('tap', req, req.params.uuid, result.bdo, referral.app);
      }
    }
  } catch (err) {
    // Counting must never cost the visitor their App Store link.
    console.warn('tap not counted:', err.message);
  }
  res.redirect(302, referral.storeUrl);
});

// What a card has earned, for the app's share screen. Same signed query as
// the card, so only someone holding the link can read it.
app.get('/r/:uuid/stats', async (req, res) => {
  // Read by the BizBuz and LinkityLink share screens, from inside the app's
  // web view. Any origin may ask: the signed query is the credential.
  res.set('Access-Control-Allow-Origin', '*');
  if (!REFERRAL_APPS[req.query.hash]) {
    return res.status(404).send({ error: 'Not an invite link' });
  }
  const result = await fetchBdo(req.params.uuid, req.query);
  if (result.error || !result.bdo) {
    return res.status(result.status || 404).send({ error: 'Not found' });
  }
  const member = cardMember(result.bdo);
  const memberRecord = member ? (await pool.members())[member] : null;
  const months = [];
  for (const month of (await pool.months()).slice(-12).reverse()) {
    const actions = await pool.cardActivity(req.params.uuid, month);
    const ledger = await pool.payouts(month);
    const paid = member && ledger?.payees?.find((p) => p.pubKey === member);
    const nineum = member ? ((await pool.tally(month))[member] || 0) : 0;
    if (Object.values(actions).some(Boolean) || paid || nineum) {
      months.push({
        month,
        taps: actions.tap,
        actions,
        nineum,
        paidCents: paid?.status === 'paid' ? paid.amountCents : 0,
        pendingCents: paid && paid.status !== 'paid' ? paid.amountCents : 0,
      });
    }
  }
  const current = monthOf(today());
  const thisMonth = months.find((m) => m.month === current)
    || { month: current, taps: 0, actions: { tap: 0, view: 0, share: 0, purchase: 0 }, nineum: 0, paidCents: 0, pendingCents: 0 };
  res.send({ thisMonth, months, connected: Boolean(memberRecord?.payout) });
});

// A HomeFront identity joins the pool, or updates its payout destination.
// Body: { pubKey, timestamp, signature } where signature is over
// timestamp + pubKey (a Fount create request, passed on to Fount), and
// optionally payout: { pubKey, addieURL } with payoutSignature over
// timestamp + pubKey + payout.pubKey + payout.addieURL. Answers { uuid }.
app.post('/pool/register', express.json(), async (req, res) => {
  const { pubKey, timestamp, signature, payout, payoutSignature } = req.body || {};
  if (!isPubKey(pubKey) || typeof timestamp !== 'string' || typeof signature !== 'string') {
    return res.status(400).send({ error: 'Send pubKey, timestamp and signature' });
  }
  if (!fount) return res.status(503).send({ error: 'The pool is not set up on this server' });
  let destination = null;
  if (payout !== undefined) {
    if (!isPubKey(payout?.pubKey) || typeof payout?.addieURL !== 'string'
        || !freshlySigned(timestamp, payoutSignature, timestamp + pubKey + payout.pubKey + payout.addieURL, pubKey)) {
      return res.status(403).send({ error: 'The payout destination is not signed by this identity' });
    }
    destination = { pubKey: payout.pubKey, addieURL: payout.addieURL };
  }
  try {
    const uuid = await fount.createMember({ pubKey, timestamp, signature });
    await pool.register(pubKey.toLowerCase(), uuid, destination);
    res.send({ uuid });
  } catch (err) {
    console.warn('pool register failed:', err.message);
    res.status(403).send({ error: 'Fount did not accept that identity' });
  }
});

// The owner shared their card from the app. Body: { uuid, query (the
// card's signed query), timestamp, signature } with signature over
// timestamp + uuid by the HomeFront identity named on the card. Once per
// card a day: a share can't be verified any further than that.
app.post('/pool/share', express.json(), async (req, res) => {
  const { uuid, query, timestamp, signature } = req.body || {};
  const app_ = REFERRAL_APPS[query?.hash];
  if (typeof uuid !== 'string' || !app_ || app_.kind !== 'card') {
    return res.status(400).send({ error: 'Send the card\'s uuid and signed query' });
  }
  const result = await fetchBdo(uuid, { timestamp: query.timestamp, hash: query.hash, signature: query.signature });
  const member = !result.error && cardMember(result.bdo);
  if (!member || !freshlySigned(timestamp, signature, timestamp + uuid, member)) {
    return res.status(403).send({ error: 'Not signed by this card\'s owner' });
  }
  const date = today();
  const counted = await pool.record({ action: 'share', member, card: uuid, app: app_.app, dedupe: `share|${uuid}|${date}`, date });
  res.send({ counted });
});

// A GetPayed invoice was paid. Reported by eumachia, signed with a key in
// POOL_REPORTERS (comma separated pubKeys). Body: { invoice, member,
// timestamp, signature } with signature over timestamp + invoice + member,
// where member is the HomeFront identity of the person who sent the
// invoice. Once per invoice.
app.post('/pool/purchase', express.json(), async (req, res) => {
  const { invoice, member, timestamp, signature, reporter } = req.body || {};
  const reporters = (process.env.POOL_REPORTERS || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (typeof invoice !== 'string' || !isPubKey(member) || !reporters.includes(String(reporter).toLowerCase())
      || !freshlySigned(timestamp, signature, timestamp + invoice + member, reporter)) {
    return res.status(403).send({ error: 'Not a signed report from a known reporter' });
  }
  const date = today();
  const counted = await pool.record({
    action: 'purchase', member: member.toLowerCase(), card: null, app: 'getpayed', dedupe: `purchase|${invoice}`, date,
  });
  res.send({ counted });
});

// Mints what's been earned, in batches: every minute, each registered
// member gets one grant per action for everything recorded since. People
// who haven't registered yet keep their actions until they do. The batch is
// stamped with the month it's minted in, which is the month it pays in.
let minting = false;
const mintEarned = async () => {
  if (!fount || minting) return;
  minting = true;
  try {
    const members = await pool.members();
    const period = monthOf(today());
    for (const [month, { events, idx }] of Object.entries(await pool.ungranted())) {
      const groups = new Map();
      for (const i of idx) {
        const e = events[i];
        if (!members[e.member]?.uuid) continue;
        const key = `${e.member}|${e.action}`;
        if (!groups.has(key)) groups.set(key, { uuid: members[e.member].uuid, action: e.action, idx: [] });
        groups.get(key).idx.push(i);
      }
      for (const g of groups.values()) {
        try {
          await fount.grant(g.uuid, g.action, g.idx.length);
          await pool.markGranted(month, g.idx, period);
        } catch (err) {
          console.warn(`minting ${g.idx.length} ${g.action} nineum failed:`, err.message);
        }
      }
    }
  } finally {
    minting = false;
  }
};
if (fount) {
  setInterval(() => mintEarned().catch((err) => console.warn('minting failed:', err.message)), 60 * 1000).unref();
}

// Listen unconditionally, the same way bdo.js and addie.js do.
//
// This used to be guarded by `import.meta.url === file://${process.argv[1]}`
// so the netlify-gateway bundle could import the app and bind it itself. That
// bundle is retired, and the guard is actively harmful under pm2: pm2's fork
// mode doesn't exec the script directly, it loads it through
// lib/ProcessContainerFork.js, so process.argv[1] is pm2's wrapper and the
// comparison is always false. savage would then load, never listen, and exit
// 0 with nothing printed — a silent crash loop. Don't reintroduce the guard.
//
// 3012, not savage's historical 3009: on the shared allyabase box 3009 is
// minnie's. PORT overrides it, and deployment should set it explicitly.
const PORT = process.env.PORT || 3012;
// ── Short links (linkityl.ink) ───────────────────────────────────────────────
//
// See shortlinks.js. nginx proxies linkityl.ink/* (dev.linkityl.ink/* on
// dev) to /l/*. Two settings:
//   SHORT_LINK_BASE  the short links' own origin, e.g. https://linkityl.ink/
//   CARD_PAGES_URL   where card pages live, e.g. https://prod.8as.world/savage/
// Unset, both fall back to this request's own address, which is right for
// local testing and wrong behind the linkityl.ink proxy.
const shortLinkStore = createShortLinkStore(process.env.SAVAGE_DATA_DIR
  ? path.join(process.env.SAVAGE_DATA_DIR, 'shortlinks')
  : path.join(process.cwd(), 'data', 'shortlinks'));
const LINKITYLINK_STORE_URL = 'https://apps.apple.com/app/id6808065892';
const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

// The owner's signature over the same message as the card's, so it can't
// be lifted onto another card.
const ownerSigned = (owner, ownerSignature, message) => {
  try {
    return /^0[23][0-9a-f]{64}$/i.test(owner) && typeof ownerSignature === 'string'
      && sessionless.verifySignature(ownerSignature, message, owner);
  } catch {
    return false;
  }
};

// A card BDO no longer has: BDO answers a deleted one with `bdo: null`
// (or a 404). Anything else (an outage, a refusal) counts as still there,
// so a link is never handed on by mistake.
const cardIsGone = async (uuid, query) => {
  try {
    const result = await fetchBdo(uuid, query);
    return result.error ? result.status === 404 : result.bdo == null;
  } catch {
    return false;
  }
};

// Called by the Linkitylink app after it publishes a card, with the same
// signed query the card's long link carries, plus optionally the owner's
// pubKey and their signature over the same message, which lets a new card
// take back its owner's link under the same name. Answers { path, url }.
app.post('/l', express.json(), async (req, res) => {
  const { uuid, timestamp, hash, signature, owner, ownerSignature } = req.body || {};
  if (typeof uuid !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(uuid) || hash !== SHORT_LINK_HASH
      || typeof timestamp !== 'string' || typeof signature !== 'string') {
    return res.status(400).json({ error: 'Send the card\'s uuid, timestamp, hash and signature' });
  }
  if (owner !== undefined && !ownerSigned(owner, ownerSignature, timestamp + uuid + hash)) {
    return res.status(400).json({ error: 'The owner signature doesn\'t match' });
  }
  const query = { timestamp, hash, signature };
  const result = await fetchBdo(uuid, query);
  if (result.error || !result.bdo) {
    return res.status(403).json({ error: 'That card could not be verified' });
  }
  try {
    const { path: shortPath } = await shortLinkStore.claim(uuid, result.bdo.name, query,
      { owner: owner?.toLowerCase(), isGone: cardIsGone });
    const base = withSlash(process.env.SHORT_LINK_BASE || absoluteUrl(req, '/l/'));
    res.json({ path: shortPath, url: `${base}${shortPath}` });
  } catch (err) {
    console.error('short link claim failed', err);
    res.status(500).json({ error: 'Could not make a short link' });
  }
});

const followShortLink = async (req, res) => {
  const parsed = parseShortPath(req.params.first, req.params.second);
  const card = parsed && await shortLinkStore.lookup(parsed.slug, parsed.ordinal);
  if (!card) {
    return res.status(404).send('No card at this link');
  }
  const pages = withSlash(process.env.CARD_PAGES_URL || absoluteUrl(req, '/'));
  res.set('Cache-Control', 'no-store');
  res.redirect(302, `${pages}user/${card.uuid}/bdo?${new URLSearchParams(card.query)}`);
};

// linkityl.ink itself: the app's listing.
app.get('/l', (req, res) => res.redirect(302, LINKITYLINK_STORE_URL));
app.get('/l/:first', followShortLink);
app.get('/l/:first/:second', followShortLink);

app.listen(PORT, () => console.log(`savage listening on ${PORT}`));

export default app;
