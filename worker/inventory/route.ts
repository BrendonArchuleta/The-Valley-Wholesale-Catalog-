/**
 * GET /api/stock — the catalog's live stock endpoint.
 *
 * Source-agnostic: everything here works against the `InventorySource`
 * contract, so it does not change when the catalog moves off Zoho Inventory.
 *
 * Returns stock keyed two ways: by normalized item name (`items`) and by the
 * source's item id (`itemsById`). The catalog's variant rows carry
 * `data-item-id`, so `itemsById` is the join that matters; `items` remains as a
 * fallback for rows without an id.
 *
 * ## Caching
 *
 * A full pull is ~17-18 upstream calls for ~3,330 items. Zoho allows 100
 * requests/minute per organization and a daily cap set by the plan, so a
 * per-visitor call is not survivable — a hundred shoppers browsing at once must
 * still cost one pull. Three layers keep it that way:
 *
 *   1. **Cache API (`caches.default`)** — the load-bearing layer. Persists
 *      across isolates within a Cloudflare colo, so the pull is shared by every
 *      visitor that colo serves, not just the ones that happen to land on a
 *      warm isolate. (This is the Workers equivalent of the `s-maxage` CDN
 *      layer the Vercel version leaned on; a Worker response is not edge-cached
 *      by Cache-Control alone, so we cache explicitly rather than assume it.)
 *   2. **Module-scope memory** — skips even the cache round trip on a warm
 *      isolate, and holds the last good payload for the outage fallback.
 *   3. **In-flight dedupe** — concurrent misses in one isolate share a single
 *      upstream pull instead of stampeding it.
 *
 * Freshness is computed from the payload's own `generated_at` rather than from
 * cache expiry, so the stored copy can outlive its TTL and still be useful:
 *
 *   age < TTL                 → serve as fresh
 *   TTL <= age < TTL + SWR    → serve immediately, refresh in the background
 *   age >= TTL + SWR          → refresh inline; if that fails, serve it flagged `stale`
 *
 * A source outage therefore degrades to slightly-old badges. Only a cold start
 * with nothing cached returns no data — and that renders no badges at all,
 * which is the catalog's pre-integration behavior. A catalog claiming
 * everything is out of stock would be worse than one showing nothing.
 */

import type { InventorySource, StockEntry, StockSnapshot } from "./source";

export interface StockRouteOptions {
  /** How long a payload counts as fresh. Default 1800s (30 min). */
  ttlSeconds: number;
  /** How long past TTL we serve immediately and revalidate in the background. Default 3600s. */
  swrSeconds: number;
  /** How long the cached copy is retained for the outage fallback. Default 21600s (6h). */
  retainSeconds: number;
}

export const DEFAULT_STOCK_ROUTE_OPTIONS: StockRouteOptions = {
  ttlSeconds: 1800,
  swrSeconds: 3600,
  retainSeconds: 21600,
};

interface StockPayload {
  ok: boolean;
  generated_at: string;
  stale: boolean;
  stale_since?: string;
  low_stock_at: number;
  count: number;
  id_count: number;
  truncated: boolean;
  items: Record<string, Omit<StockEntry, "n">>;
  itemsById: Record<string, Omit<StockEntry, "n">>;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Fixed cache key. Query strings (the client's `?t=` cache-buster) deliberately
 *  do not fragment it — a forced browser refresh should bypass the browser
 *  cache, not our upstream call budget. */
const CACHE_PATH = "/api/stock";

let memory: { payload: StockPayload; builtAt: number } | null = null;
let inFlight: Promise<StockPayload> | null = null;

/** Drop the display name from the wire payload — the client already knows it
 *  (it is the lookup key, or is irrelevant for the id-keyed map). Saves a
 *  meaningful chunk of the response on a 3k-item catalog. */
function slimify(map: Record<string, StockEntry>): Record<string, Omit<StockEntry, "n">> {
  const out: Record<string, Omit<StockEntry, "n">> = Object.create(null);
  for (const key of Object.keys(map)) {
    const { n: _name, ...rest } = map[key];
    void _name;
    out[key] = rest;
  }
  return out;
}

function toPayload(snapshot: StockSnapshot): StockPayload {
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    stale: false,
    low_stock_at: snapshot.lowStockAt,
    count: snapshot.count,
    id_count: snapshot.idCount,
    truncated: snapshot.truncated,
    items: slimify(snapshot.items),
    itemsById: slimify(snapshot.itemsById),
  };
}

function ageSeconds(payload: StockPayload): number {
  const generated = Date.parse(payload.generated_at);
  if (!Number.isFinite(generated)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - generated) / 1000);
}

/** `caches.default` is a Workers extension the DOM `CacheStorage` type does not
 *  describe. Reached through a cast so this compiles with or without
 *  `@cloudflare/workers-types` present. */
function edgeCache(): Cache | null {
  const storage = (globalThis as { caches?: { default?: Cache } }).caches;
  return storage && storage.default ? storage.default : null;
}

function cacheKey(request: Request): Request {
  return new Request(new URL(CACHE_PATH, request.url).toString(), { method: "GET" });
}

async function readCache(request: Request): Promise<StockPayload | null> {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(cacheKey(request));
    if (!hit) return null;
    return (await hit.json()) as StockPayload;
  } catch {
    return null;
  }
}

async function writeCache(request: Request, payload: StockPayload, options: StockRouteOptions): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(
      cacheKey(request),
      new Response(JSON.stringify(payload), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          // Retention only — freshness is decided from `generated_at`, so the
          // copy stays available past TTL to back the outage fallback.
          "cache-control": `public, s-maxage=${options.retainSeconds}`,
        },
      })
    );
  } catch {
    // A cache write failure is not worth failing the request over.
  }
}

/** Pull from the source and populate both cache layers. Concurrent callers in
 *  this isolate share one pull. */
function refresh(
  request: Request,
  source: InventorySource,
  options: StockRouteOptions
): Promise<StockPayload> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const payload = toPayload(await source.fetchStock());
    memory = { payload, builtAt: Date.now() };
    await writeCache(request, payload, options);
    return payload;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

function json(payload: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The catalog is same-origin, so CORS is only needed if the catalog is
      // ever served from another host. Harmless — this endpoint exposes no
      // secrets, only public stock counts.
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
}

function freshHeaders(options: StockRouteOptions, source: string): Record<string, string> {
  return {
    "cache-control": `public, max-age=0, s-maxage=${options.ttlSeconds}, stale-while-revalidate=${options.swrSeconds}`,
    "x-stock-source": source,
  };
}

export async function handleStockRequest(
  request: Request,
  ctx: ExecutionContextLike,
  source: InventorySource,
  options: StockRouteOptions = DEFAULT_STOCK_ROUTE_OPTIONS
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "Method not allowed" }, 405, { allow: "GET, HEAD" });
  }

  // Layer 2 then layer 1: memory is cheaper, the cache is shared more widely.
  let cached: StockPayload | null = memory ? memory.payload : null;
  let servedFrom = "memory";
  if (!cached || ageSeconds(cached) >= options.ttlSeconds) {
    const fromCache = await readCache(request);
    if (fromCache && (!cached || ageSeconds(fromCache) < ageSeconds(cached))) {
      cached = fromCache;
      servedFrom = "cache";
      memory = { payload: fromCache, builtAt: Date.now() };
    }
  }

  const age = cached ? ageSeconds(cached) : Number.POSITIVE_INFINITY;

  if (cached && age < options.ttlSeconds) {
    return json(cached, 200, freshHeaders(options, servedFrom));
  }

  // Past TTL but inside the stale-while-revalidate window: answer now, refresh
  // behind the response so no visitor waits on a 17-call upstream pull.
  if (cached && age < options.ttlSeconds + options.swrSeconds) {
    ctx.waitUntil(
      refresh(request, source, options).catch((err: unknown) => {
        console.error("[api/stock] background refresh failed:", err instanceof Error ? err.message : err);
      })
    );
    return json(cached, 200, freshHeaders(options, "revalidating"));
  }

  try {
    const payload = await refresh(request, source, options);
    return json(payload, 200, freshHeaders(options, "upstream"));
  } catch (err: unknown) {
    console.error("[api/stock] inventory pull failed:", err instanceof Error ? err.message : err);

    if (cached) {
      // Serve the last good data rather than breaking the catalog.
      return json({ ...cached, stale: true, stale_since: cached.generated_at }, 200, {
        "cache-control": "public, max-age=0, s-maxage=60",
        "x-stock-source": "stale",
      });
    }

    // Nothing cached: tell the client to render no badges at all. A catalog with
    // no stock info is fine; a catalog claiming everything is out of stock is not.
    return json(
      { ok: false, error: "Inventory temporarily unavailable", items: {}, itemsById: {}, count: 0 },
      503,
      { "cache-control": "public, max-age=0, s-maxage=60", "x-stock-source": "error" }
    );
  }
}

/** Read the cache-tuning knobs from the Worker env, falling back to defaults. */
export function readStockRouteOptions(env: unknown): StockRouteOptions {
  const read = (name: string, fallback: number): number => {
    const bag = env as Record<string, unknown> | null | undefined;
    let raw = bag?.[name];
    if (typeof raw !== "string" && typeof process !== "undefined" && process.env) raw = process.env[name];
    const parsed = Number(raw);
    return typeof raw === "string" && raw !== "" && Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    ttlSeconds: read("STOCK_TTL_SECONDS", DEFAULT_STOCK_ROUTE_OPTIONS.ttlSeconds),
    swrSeconds: read("STOCK_SWR_SECONDS", DEFAULT_STOCK_ROUTE_OPTIONS.swrSeconds),
    retainSeconds: read("STOCK_RETAIN_SECONDS", DEFAULT_STOCK_ROUTE_OPTIONS.retainSeconds),
  };
}
