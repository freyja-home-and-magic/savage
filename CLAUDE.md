# savage — Development Documentation

## Overview

savage serves a BDO record's `svg` property as a live webpage with Open Graph
preview tags. It is the thing that turns a published BDO into a shareable
link: BizBuz and Linkitylink both render a card to SVG, publish it to BDO, and
hand out a savage URL.

**Location**: `/savage/`
**Stack**: Node 18+, Express 4, ESM. No database, no build step.
**Extracted from allyabase** (was `allyabase/deployment/savage/`) so it can be
deployed on its own — see "History" below.

## Architecture

One file: `src/server/node/savage.js` (~170 lines). Three routes, all reading
through to BDO:

- `GET /user/:uuid/bdo` → HTML wrapper (`wrapHTML`)
- `GET /user/:uuid/bdo/svg` → the sanitized SVG, `image/svg+xml`
- `GET /user/:uuid/bdo/vcard` → the record's `vcard`, `text/vcard`, download

`fetchBdo` forwards the incoming query string verbatim to BDO's
`GET /user/:uuid/bdo`. savage holds no keys and performs no auth of its own —
the query string *is* the credential, pre-signed by whoever published the
record. That's what lets a savage URL be permanent: the signature doesn't
expire, and savage never needs to interpret it.

### Stateless by design

No persistence layer, no identity, no writes. Every request is a pass-through
plus a transform. This is why the service can be scaled or redeployed freely
and why its extraction from allyabase was straightforward — it had no
allyabase-internal dependencies to sever.

### Sanitization is load-bearing

`sanitizeSvg` runs untrusted SVG through `teleportation-js`'s
`removeJavaScript` before it's served as markup. Note the import is the
internal helper path (`teleportation-js/src/node-remove-javascript.js`), not
the package main — the main entry is `safeTeleportationParser`, a different
feature.

JSDOM parses even a bare `<svg>` fragment as a full document, so `sanitizeSvg`
pulls the `<svg>` element back out of the wrapper rather than returning the
whole document.

**Consequence for callers**: a published SVG cannot contain behaviour.
BizBuz's referral card wants to auto-redirect to the App Store and can't — it
uses a plain `<a href>` button instead. Any app publishing here should assume
scripts, `javascript:` URLs, and `on*` attributes will be stripped.

### Embedded photos: the one exception, and why it exists

`removeJavaScript` strips every `data:` URI, since `data:` is a script vector.
That silently deleted the **photo** out of every card BizBuz and LinkityLink
published: both base64 a resized JPEG into the SVG (nothing in that stack
uploads files), so cards looked right in the app and rendered on the web with
an empty avatar. Nothing errored — the attribute was simply gone.

`sanitizeSvg` now:

1. Stashes anything matching `SAFE_IMAGE_DATA_URI`
   (`data:image/(png|jpe?g|gif|webp);base64,…`) behind a
   `savage-safe-image:` placeholder prefix.
2. Runs `removeJavaScript` as before, on markup with no `data:` left in it.
3. Restores the stashed values **onto `<image>` elements only**.

Three deliberate narrownesses:

- **Raster only.** `image/svg+xml` is not in the allowlist: an SVG can carry
  script, so a data-URI SVG would be a way to smuggle behaviour back in past
  the strip.
- **`<image>` only.** A restored URI can't land on an `href`, a
  `style`, or anywhere it would be fetched or executed as anything but a
  bitmap.
- **The placeholder is a prefix on a value**, not a comment or a node, so it
  survives JSDOM's parse-and-serialize round trip intact.

If a published card loses its photo again, this is the pass to look at
first — and if you widen the allowlist, widen it knowing all three
constraints are load-bearing.

### Absolute URLs and reverse proxies

The HTML page references itself (`og:image` → `/svg`, "Save Contact" →
`/vcard`), so savage must know its external scheme, host, and path prefix.
Behind path-based nginx routing, `proxy_pass` with a trailing slash strips the
`/savage` prefix before savage sees it.

`absoluteUrl` resolves this from `x-forwarded-host` / `x-forwarded-proto` /
`x-forwarded-prefix`, falling back to `req.get('host')` / `req.protocol` /
`PUBLIC_PREFIX`. Forwarded headers comma-append across proxy hops
(`"https,https"`), so `firstForwarded` keeps the first value — the original
client-facing one.

**The stock allyabase nginx config sets Host and X-Forwarded-Proto but not
X-Forwarded-Prefix.** Either add `proxy_set_header X-Forwarded-Prefix /savage;`
to the location block or set `PUBLIC_PREFIX=/savage` on the service. Without
one of them the page renders but its preview image and vCard links 404.

## Configuration

See README.md for the full table. In short: set `BDO_URL` and `PUBLIC_PREFIX`;
`LOCALHOST`/`SUBDOMAIN` are legacy fallbacks kept for older single-box setups.

Default port is **3012**, not savage's historical 3009 — 3009 is minnie's in
the shared allyabase port map, and the two collided.

## History

savage lived at `allyabase/deployment/savage/` and was deployed as part of the
Netlify gateway bundle (a `serverless-http` wrapper in `netlify/functions/`).
That bundle is retired. On extraction the Netlify artifacts (`netlify.toml`,
`netlify/functions/savage.js`, the `serverless-http` dependency) were dropped
and `BDO_URL`/`PUBLIC_PREFIX` were added so the service can be pointed at any
BDO and mounted at any prefix.

Unlike the other allyabase services, savage was never its own submodule — it
was committed directly into the allyabase repo on the `netlify-packaging`
branch.

## Related

- **BDO** — the service savage reads through to
- **BizBuz / Linkitylink** — publish SVG cards and hand out savage URLs
- **eumachia** — the sibling extracted at the same time; renders an
  *interactive* pay page, which savage deliberately cannot do since it strips
  all JavaScript

## Referral taps and payouts (October 2026)

The HomeFront referral program: each month, 50% of what Apple pays for
BizBuz and for LinkityLink is shared among the people whose invite cards
and card pages were tapped through to the App Store, by tap count, capped at $50 a person. Logic in
`src/server/node/referrals.js`, tested by `npm test`.

- **`GET /r/:uuid?<the card's signed query>`**: an invite card's "Get"
  button. Counts one tap per visitor per card per day (visitor = salted hash
  of IP and user agent; the IP is `X-Real-IP` from nginx, never the
  client-settable first `X-Forwarded-For` entry), skips link-preview bots,
  and always redirects to the app's App Store listing from `REFERRAL_APPS`
  (never a URL from the request). Unverifiable taps still redirect, uncounted.
- **`GET /r/:uuid/stats?<signed query>`**: taps and payouts for that card,
  for the app's share screen.
- **"Make your own" on card pages:** with `SAVAGE_GET_APP_CTA=on`, the page
  for an ordinary BizBuz or Linkitylink card (hash `bizbuz-card` /
  `linkitylink-card`) gets a second button under "Save Contact", pointing at
  `/r/:uuid` with the card's own signed query. Taps credit the card's owner
  exactly like invite taps, and share the same $50 cap, when the card
  carries a `payout` (the apps add it once the program is live and the
  owner is connected in GetPayed). Invite cards get no extra button; they
  already are one. Off by default, so flip it with the program's launch.
- **Data:** `SAVAGE_DATA_DIR/referrals/` (default `./data/referrals`, gitignored):
  `taps-YYYY-MM.json`, `payouts-YYYY-MM.json`, and a `.salt`. Back it up;
  it's the record of who is owed what.
- **Paying:** `npm run referral-payouts -- --month 2026-10 --proceeds
  bizbuz=420.00 --proceeds linkitylink=80.00` is a dry run; add `--pay` to
  send through addie's `/platform/payout`, signed by the platform admin key
  (`--new-admin-key` makes one). Only https *.8as.world addies are ever sent
  a payout request, since the addie address on a card is its owner's to
  write. Reruns skip anyone already paid.

