'use strict';

/**
 * GET /api/stock
 *
 * Returns live stock for the Valley catalog, keyed two ways: by normalized item
 * name (`items`) and by Zoho item_id (`itemsById`). Prefer itemsById when the
 * catalog carries a Zoho Item ID — it's immune to the name-formatting drift that
 * cost this catalog a real chunk of its match rate on the old vs. new flavor
 * naming conventions. `items` (name-keyed) remains as a fallback for rows without
 * an ID.
 *
 * Caching is three-deep, on purpose:
 *   1. Vercel's CDN (s-maxage) absorbs visitor traffic — most requests never
 *      reach this function at all.
 *   2. A module-scope cache absorbs cold-start bursts on a warm instance.
 *   3. The last good payload is retained and served stale if Zoho errors, so a
 *      Zoho outage degrades to slightly-old badges instead of a broken catalog.
 *
 * Response shape:
 * {
 *   ok: true,
 *   generated_at: "2026-08-14T18:00:00.000Z",
 *   stale: false,
 *   low_stock_at: 6,
 *   count: 2972,
 *   items: { "brand|eliquid|100ml|3mg|blue razz": { q: 42, s: "in", k: "SKU", id: "…" } },
 *   itemsById: { "910165756000012345": { q: 42, s: "in", k: "SKU" } }
 * }
 */

const { fetchStock, LOW_STOCK_AT } = require('./_zoho.js');

// How long the CDN may serve a cached copy. 1800s = 30 min keeps the daily
// Zoho call budget at roughly 48 pulls x ~15 pages = ~720 calls/day.
const TTL_SECONDS = Number(process.env.STOCK_TTL_SECONDS || 1800);
const SWR_SECONDS = Number(process.env.STOCK_SWR_SECONDS || 3600);

let cache = { payload: null, builtAt: 0 };
let inFlight = null;

async function build() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const result = await fetchStock();

    // Drop the display name from the wire payload — the client already knows it
    // (it is the lookup key, or is irrelevant for the ID-keyed map). Saves a
    // meaningful chunk of the response on a 3k-item catalog.
    const slimify = (map) => {
      const out = Object.create(null);
      for (const key of Object.keys(map)) {
        const { n, ...rest } = map[key];
        void n;
        out[key] = rest;
      }
      return out;
    };

    const payload = {
      ok: true,
      generated_at: new Date().toISOString(),
      stale: false,
      low_stock_at: LOW_STOCK_AT,
      count: result.count,
      id_count: result.idCount,
      truncated: result.truncated,
      items: slimify(result.items),
      itemsById: slimify(result.itemsById),
    };
    cache = { payload, builtAt: Date.now() };
    return payload;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // The catalog is a static page on the same origin; CORS is only needed if you
  // ever serve the catalog from a different host (e.g. a custom domain during
  // a migration). Harmless to leave on — this endpoint exposes no secrets.
  res.setHeader('Access-Control-Allow-Origin', '*');

  const fresh = cache.payload && Date.now() - cache.builtAt < TTL_SECONDS * 1000;

  try {
    const payload = fresh ? cache.payload : await build();
    res.setHeader(
      'Cache-Control',
      `public, max-age=0, s-maxage=${TTL_SECONDS}, stale-while-revalidate=${SWR_SECONDS}`
    );
    res.setHeader('X-Stock-Source', fresh ? 'memory' : 'zoho');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('[api/stock] Zoho pull failed:', err && err.message);

    if (cache.payload) {
      // Serve the last good data rather than breaking the catalog.
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
      res.setHeader('X-Stock-Source', 'stale');
      return res.status(200).json({
        ...cache.payload,
        stale: true,
        stale_since: new Date(cache.builtAt).toISOString(),
      });
    }

    // Nothing cached: tell the client to render no badges at all. A catalog with
    // no stock info is fine; a catalog claiming everything is out of stock is not.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
    res.setHeader('X-Stock-Source', 'error');
    return res.status(503).json({
      ok: false,
      error: 'Inventory temporarily unavailable',
      items: {},
      itemsById: {},
      count: 0,
    });
  }
};
