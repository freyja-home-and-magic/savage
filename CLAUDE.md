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

## The payment pool (October 2026)

HomeVentory's payment pool, as `getpayed/PAYMENT_POOL.md` describes it:
useful actions earn nineum in HomeVentory's Fount galaxy, and after each
month 50% of what Apple paid for the apps is shared by the nineum minted
that month. Logic in `src/server/node/pool.js` (store and payout
algorithm) and `fount-client.js`, tested by `npm test`. This replaced the
first referral design (App Store taps only, per-app pools, a flat $50 cap).

- **Who earns:** every HomeFront user has one HomeFront identity (a
  sessionless key the apps share through the keychain), with a Fount user.
  Cards carry its pubKey as `fount: { pubKey }`.
- **`POST /pool/register`** `{pubKey, timestamp, signature, payout?,
  payoutSignature?}`: `signature` is a Fount create request (over
  `timestamp + pubKey`), which savage passes on to Fount; Fount's answer is
  the proof of which uuid owns the key. A payout destination
  (`{pubKey, addieURL}`, GetPayed's) must be signed by the identity, over
  `timestamp + pubKey + payout.pubKey + payout.addieURL`, so nobody can
  point someone else's earnings at themselves. Anyone can put any pubKey
  on a card, but that only gifts nineum.
- **What earns, one nineum each:**
  - `tap`: `GET /r/:uuid`, an invite card's "Get" or a card page's "Make your own".
  - `view`: a BizBuz or Linkitylink card's page (`bizbuz-card` / `linkitylink-card`).
  - `share`: `POST /pool/share` `{uuid, query, timestamp, signature}`, signed
    by the identity on the card. Once per card a day, since it can't be
    verified further.
  - `purchase`: `POST /pool/purchase` `{invoice, member, reporter, timestamp,
    signature}` from eumachia, whose key must be in `POOL_REPORTERS`. Once
    per invoice. Credits the person who sent the invoice.

  Taps and views count once per visitor per card per day (visitor = salted
  hash of IP and user agent; the IP is `X-Real-IP`), never bots. Nothing is
  credited through a referral's referrals.
- **Minting:** every minute, savage mints what each registered member has
  earned, one grant per action, with its own Fount user (needs an `fe` in
  the galaxy). Size, texture and shape are random, the direction byte says
  which action. Unregistered members keep their actions until they
  register. A batch counts for the month it's minted in, which is what its
  period byte says.
- **Setup:** `npm run pool-setup` (see the script's header): make the
  galaxy owner key, claim the galaxy, print savage's Fount uuid, grant it
  minting. Fount needs `PERIOD_GALAXIES=<galaxy>`. Fount's default galaxy
  28880014 is open to anyone and must not be used.
- **Paying:** `npm run pool-payouts -- --month 2026-10 --proceeds
  bizbuz=420.00 --proceeds linkitylink=80.00` is a dry run; `--pay` sends
  through addie's `/platform/payout` with the platform admin key, only to
  https `*.8as.world` addies. The pool is 50% of total proceeds, shared by
  nineum among people with a payout destination; the cap is the average
  share plus two standard deviations (over those people), and what it
  frees is shared among those below it, repeatedly, until nobody is over.
  Reruns skip anyone already paid.
- **Data:** `SAVAGE_DATA_DIR/pool/`: `members.json`, `events-YYYY-MM.json`,
  `payouts-YYYY-MM.json`, `.salt`, and `fount-keys.json` (savage's Fount
  key, mode 600). Back it up; it's the record of who is owed what.
- **"Make your own"** on card pages is still behind `SAVAGE_GET_APP_CTA=on`.

## Linkitylink short links (October 2026)

`linkityl.ink/<name>`, and `linkityl.ink/2/<name>`, `/3/<name>`... when
the name is already taken (first come, first served). Logic in
`src/server/node/shortlinks.js`; nginx server blocks in the linkitylink
repo's `deploy/nginx/{,dev.}linkityl.ink.nginx.conf` send every path to
`/l/`, passing `$request_uri` so non-ASCII names arrive intact.

- **`POST /l`** `{uuid, timestamp, hash, signature, owner?, ownerSignature?}`:
  the Linkitylink app calls this after each publish, with the card's own
  signed query. savage fetches the card with it (so only a real
  `linkitylink-card` can register) and takes the name from the card.
  `owner` is the pubKey of a key the app keeps for the life of the install,
  and `ownerSignature` its signature over the same `timestamp+uuid+hash`
  (so it can't be lifted onto another card). Answers `{path, url}`.
- **`GET /l/<name>`, `/l/<n>/<name>`**: 302 to the card's page at
  `CARD_PAGES_URL`. Names are tidied the same way both ways (lower case,
  anything but letters and digits becomes a hyphen), so `/Jane-Doe` finds
  `jane-doe`. `GET /l/` goes to the App Store listing.
- **A card keeps its place:** republishing returns the same link; renaming
  adds a link for the new name and keeps the old one, which may be printed.
- **A link outlives its card, for its owner only:** when a card is
  deleted, its link stays reserved. A new card from the same owner with the
  same name takes it back (savage checks the old card is gone: BDO answers
  `bdo: null`). Nobody else ever gets it, and two live cards of one owner
  with one name keep a link each. A link whose owner is gone for good (app
  deleted, so the key is lost) stays reserved and 404s on the card page.
  Cards registered without an owner can't be reclaimed.
- **Data:** `SAVAGE_DATA_DIR/shortlinks/shortlinks.json`. Back it up with
  `referrals/`; losing it breaks every short link handed out.

