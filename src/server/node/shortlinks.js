// Short links for Linkitylink cards: linkityl.ink/<name>, and when a name is
// already taken, linkityl.ink/2/<name>, /3/<name> and so on, first come
// first served.
//
// linkityl.ink (dev.linkityl.ink on dev) is proxied by nginx to savage's
// /l/ routes. The app registers each card after publishing it (POST /l)
// and hands out the short link in place of the long pre-signed one. A
// short link redirects to the card's page here.
//
// savage verifies a registration by fetching the card with the signed query
// it's given, and takes the name from the card itself, so a registration
// can only ever point a card's own name at that card. A card keeps its
// place for good: republishing returns the same link, and renaming adds a
// link for the new name without taking away the old one, which may already
// be printed or shared.
//
// A link outlives its card, too. The app registers each card with its
// owner, a key it keeps for the life of the install, so when someone deletes
// a card and makes a new one under the same name, the new card gets the old
// link back. Nobody else ever gets it: a link whose owner is gone for good
// stays reserved, and 404s, rather than pointing at a stranger.

import { promises as fs } from 'node:fs';
import path from 'node:path';

// Only Linkitylink's own cards get short links.
export const SHORT_LINK_HASH = 'linkitylink-card';

const MAX_SLUG = 64;

/// The name as it appears in a link: lower case, runs of anything but
/// letters and digits (in any script) collapsed to one hyphen, trimmed.
/// "Zoë O'Brien" becomes "zoë-o-brien"; a name with nothing usable in it
/// becomes "card".
export const slugify = (name) => {
  const slug = String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug || 'card';
};

/// The path for the nth card to claim a slug: the first gets the bare name.
export const shortPath = (slug, ordinal) =>
  (ordinal === 1 ? encodeURIComponent(slug) : `${ordinal}/${encodeURIComponent(slug)}`);

/// Reads a short path's parts back: ("2", "jane") or ("jane"). The name is
/// tidied the same way as at registration, so a link typed as
/// linkityl.ink/Jane-Doe still finds jane-doe. Returns null when the
/// ordinal isn't a positive number.
export const parseShortPath = (first, second) => {
  if (second === undefined) return { slug: slugify(first), ordinal: 1 };
  if (!/^[1-9]\d{0,5}$/.test(first)) return null;
  return { slug: slugify(second), ordinal: Number(first) };
};

/// The lookup, one JSON file under `dir`:
///   names: slug -> [uuid, uuid, ...]  (position + 1 is the ordinal)
///   cards: uuid -> { query, owner }   (the signed query to fetch it with,
///                                      and its owner's pubKey if known)
/// Writes are serialised and atomic (temp file, then rename).
export const createShortLinkStore = (dir) => {
  const file = path.join(dir, 'shortlinks.json');
  let chain = Promise.resolve();
  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  const read = async () => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return { names: {}, cards: {} };
      throw err;
    }
  };
  const write = async (data) => {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  };

  return {
    /// Gives a card a place under its name, or returns the one it has.
    /// `query` is kept fresh: the latest signed query the app sent.
    ///
    /// With an `owner`, a new card takes back a place its owner already
    /// holds under this name, but only once the card there is gone
    /// (`isGone(uuid, query)` resolves true), so two live cards of one owner with
    /// one name each keep their own link.
    claim: (uuid, name, query, { owner, isGone } = {}) =>
      serial(async () => {
        const data = await read();
        const slug = slugify(name);
        const holders = data.names[slug] || [];
        let index = holders.indexOf(uuid);
        if (index === -1 && owner && isGone) {
          for (const [i, held] of holders.entries()) {
            if (data.cards[held]?.owner === owner && await isGone(held, data.cards[held].query)) {
              holders[i] = uuid;
              index = i;
              break;
            }
          }
        }
        if (index === -1) {
          holders.push(uuid);
          index = holders.length - 1;
        }
        data.names[slug] = holders;
        data.cards[uuid] = { query, owner: owner || data.cards[uuid]?.owner };
        await write(data);
        return { slug, ordinal: index + 1, path: shortPath(slug, index + 1) };
      }),

    /// The card at a short path, as { uuid, query }, or null.
    lookup: async (slug, ordinal) => {
      const data = await read();
      const uuid = data.names[slug]?.[ordinal - 1];
      const card = uuid && data.cards[uuid];
      return card ? { uuid, query: card.query } : null;
    },
  };
};
