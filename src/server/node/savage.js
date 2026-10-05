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
import { REFERRAL_APPS, createStore, isBot, visitorKey, monthOf, tapCount } from './referrals.js';
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

const wrapHTML = (svg, imageUrl, title, vcardUrl, palette, description) => {
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

    res.set('Content-Type', 'text/html');
    // palette is optional and validated in wrapHTML; a record without one
    // renders exactly as it did before palettes existed.
    res.send(wrapHTML(result.bdo.svg, imageUrl, title, vcardUrl, result.bdo.palette, description));
  } catch (err) {
    console.warn('savage error:', err);
    res.status(500).send('Internal error');
  }
});

// ── Referral taps ───────────────────────────────────────────────────────────
//
// An invite card's "Get" button points here, carrying the card's own signed
// query. savage counts the tap (see referrals.js for what counts) and sends
// the visitor on to the App Store. The redirect target comes from
// REFERRAL_APPS, never from the request, and a tap that can't be verified
// still gets its redirect, it just isn't counted.
const referralStore = createStore(process.env.SAVAGE_DATA_DIR
  ? path.join(process.env.SAVAGE_DATA_DIR, 'referrals')
  : path.join(process.cwd(), 'data', 'referrals'));

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

app.get('/r/:uuid', async (req, res) => {
  const referral = REFERRAL_APPS[req.query.hash];
  if (!referral) {
    return res.status(404).send('Not an invite link');
  }
  res.set('Cache-Control', 'no-store');
  try {
    const ua = req.get('user-agent');
    if (!isBot(ua)) {
      const result = await fetchBdo(req.params.uuid, req.query);
      if (!result.error && result.bdo && result.bdo.svg) {
        const payout = result.bdo.payout && result.bdo.payout.pubKey && result.bdo.payout.addieURL
          ? { pubKey: result.bdo.payout.pubKey, addieURL: result.bdo.payout.addieURL }
          : null;
        const date = today();
        const salt = await referralStore.salt();
        await referralStore.recordTap({
          uuid: req.params.uuid,
          app: referral.app,
          payout,
          visitor: visitorKey(salt, clientIp(req), ua, req.params.uuid, date),
          date,
        });
      }
    }
  } catch (err) {
    // Counting must never cost the visitor their App Store link.
    console.warn('referral tap not counted:', err.message);
  }
  res.redirect(302, referral.storeUrl);
});

// What an invite card has earned, for the app's share screen. Same signed
// query as the card, so only someone holding the link can read it.
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
  const months = [];
  for (const month of (await referralStore.months()).slice(0, 12)) {
    const card = (await referralStore.taps(month))[req.params.uuid];
    const ledger = await referralStore.payouts(month);
    const paid = ledger?.payees?.find((p) => p.cards?.includes(req.params.uuid));
    if (card || paid) {
      months.push({
        month,
        taps: card ? tapCount(card) : 0,
        paidCents: paid?.status === 'paid' ? paid.amountCents : 0,
        pendingCents: paid && paid.status !== 'paid' ? paid.amountCents : 0,
      });
    }
  }
  const current = monthOf(today());
  const thisMonth = months.find((m) => m.month === current) || { month: current, taps: 0, paidCents: 0, pendingCents: 0 };
  res.send({ thisMonth, months, connected: Boolean(result.bdo.payout) });
});

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
app.listen(PORT, () => console.log(`savage listening on ${PORT}`));

export default app;
