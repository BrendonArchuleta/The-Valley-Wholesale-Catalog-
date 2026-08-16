/**
 * Zoho Inventory adapter.
 *
 * This is the ONLY file that knows Zoho exists. When the catalog moves onto the
 * internal admin console, add a sibling module that returns a `StockSnapshot`
 * and repoint the one `createZohoSource(env)` call in `worker/index.ts`.
 * Nothing else — route, caching, response shape, browser badge layer — changes.
 *
 * Ported from the Vercel version (`api/_zoho.js`, commit de93b92) to the
 * Workers runtime. The differences are all plumbing: credentials arrive on the
 * Worker `env` object instead of `process.env`, and the module-scope token
 * cache now lives for the life of an isolate rather than a warm Lambda.
 */

import type { InventorySource, StockEntry, StockSnapshot, StockStatus } from "./source";
import { normalizeName } from "./source";

const PER_PAGE = 200;
const MAX_PAGES = 60; // hard stop: 12,000 items. Guards against a pagination bug burning the daily API quota.
const DEFAULT_LOW_STOCK_AT = 6;

export interface ZohoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orgId: string;
  /** Data center: com (US), eu, in, com.au, jp, ca, com.cn, sa. */
  dc: string;
  lowStockAt: number;
}

/** The subset of a Zoho item row this integration reads. */
interface ZohoItem {
  item_id?: string | number;
  name?: string;
  sku?: string;
  track_inventory?: boolean;
  available_stock?: number | string | null;
  actual_available_stock?: number | string | null;
  stock_on_hand?: number | string | null;
}

interface ZohoItemsPage {
  items?: ZohoItem[];
  page_context?: { has_more_page?: boolean };
  message?: string;
}

/**
 * Credentials come from the Worker `env` object (Site settings → environment
 * variables and secrets). `process.env` is checked as a fallback so the same
 * code works under `nodejs_compat` and in local dev from a `.dev.vars`/`.env`
 * file, whichever mechanism the runtime populates.
 */
function readVar(env: unknown, name: string): string | undefined {
  const fromBinding = (env as Record<string, unknown> | null | undefined)?.[name];
  if (typeof fromBinding === "string" && fromBinding !== "") return fromBinding;

  if (typeof process !== "undefined" && process.env) {
    const fromProcess = process.env[name];
    if (typeof fromProcess === "string" && fromProcess !== "") return fromProcess;
  }

  return undefined;
}

function requiredVar(env: unknown, name: string): string {
  const value = readVar(env, name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function readNumberVar(env: unknown, name: string, fallback: number): number {
  const raw = readVar(env, name);
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

export function readZohoConfig(env: unknown): ZohoConfig {
  return {
    clientId: requiredVar(env, "ZOHO_CLIENT_ID"),
    clientSecret: requiredVar(env, "ZOHO_CLIENT_SECRET"),
    refreshToken: requiredVar(env, "ZOHO_REFRESH_TOKEN"),
    orgId: requiredVar(env, "ZOHO_ORG_ID"),
    dc: (readVar(env, "ZOHO_DC") || "com").replace(/^\./, ""),
    lowStockAt: readNumberVar(env, "LOW_STOCK_THRESHOLD", DEFAULT_LOW_STOCK_AT),
  };
}

// ---------------------------------------------------------------------------
// Access token cache (module scope — shared by every request an isolate
// handles, so we are not burning a token call on each one).
// ---------------------------------------------------------------------------
let tokenCache: { value: string | null; expiresAt: number } = { value: null, expiresAt: 0 };
let tokenInFlight: Promise<string> | null = null;

function accountsHost(dc: string): string {
  return `https://accounts.zoho.${dc}`;
}

function apiHost(dc: string): string {
  return `https://www.zohoapis.${dc}`;
}

async function getAccessToken(config: ZohoConfig, forceRefresh = false): Promise<string> {
  if (forceRefresh) tokenCache = { value: null, expiresAt: 0 };
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    const params = new URLSearchParams({
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    });

    const res = await fetch(`${accountsHost(config.dc)}/oauth/v2/token?${params}`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };

    if (!res.ok || !body.access_token) {
      throw new Error(
        `Zoho token refresh failed (HTTP ${res.status}): ${body.error || JSON.stringify(body).slice(0, 200)}`
      );
    }

    // Zoho returns expires_in in seconds (typically 3600). Retire it 5 min early.
    const ttlMs = (Number(body.expires_in) || 3600) * 1000;
    tokenCache = { value: body.access_token, expiresAt: Date.now() + ttlMs - 5 * 60 * 1000 };
    return body.access_token;
  })().finally(() => {
    tokenInFlight = null;
  });

  return tokenInFlight;
}

// ---------------------------------------------------------------------------
// One page of items, with retry on 429 / 5xx and a single re-auth on 401.
// ---------------------------------------------------------------------------
async function fetchPage(
  config: ZohoConfig,
  page: number,
  token: string,
  attempt = 0,
  reauthed = false
): Promise<ZohoItemsPage> {
  const params = new URLSearchParams({
    organization_id: config.orgId,
    page: String(page),
    per_page: String(PER_PAGE),
    filter_by: "Status.Active",
  });

  const res = await fetch(`${apiHost(config.dc)}/inventory/v1/items?${params}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 3) throw new Error(`Zoho items page ${page} failed after retries (HTTP ${res.status})`);
    const waitMs = Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchPage(config, page, token, attempt + 1, reauthed);
  }

  // Token went stale mid-run — force one refresh and retry the page. Tracked
  // separately from `attempt` so a preceding 429 backoff does not consume the
  // one re-auth we allow ourselves.
  if (res.status === 401 && !reauthed) {
    const fresh = await getAccessToken(config, true);
    return fetchPage(config, page, fresh, attempt, true);
  }

  const body = (await res.json().catch(() => ({}))) as ZohoItemsPage;
  if (!res.ok) {
    throw new Error(`Zoho items page ${page} failed (HTTP ${res.status}): ${body.message || "unknown error"}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Stock bucketing.
//
// available_stock = on hand minus quantity committed to open sales orders.
// That is the number a rep would quote, so it is what we publish. Items that
// are not inventory-tracked (services, drop-ship-only rows) get 'na' and the
// catalog renders no badge for them rather than a misleading "Out of stock".
// ---------------------------------------------------------------------------
function readStock(item: ZohoItem, lowStockAt: number): { q: number | null; s: StockStatus } {
  // Explicitly untracked items (services, non-inventory rows) have no meaningful
  // stock number — do not fabricate one.
  if (item.track_inventory === false) return { q: null, s: "na" };

  const raw = [item.available_stock, item.actual_available_stock, item.stock_on_hand].find(
    (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))
  );

  if (raw === undefined) return { q: null, s: "na" };

  const q = Math.max(0, Math.floor(Number(raw) || 0));
  const s: StockStatus = q <= 0 ? "out" : q <= lowStockAt ? "low" : "in";
  return { q, s };
}

// ---------------------------------------------------------------------------
// Full pull.
// ~3,330 active items = ~17 requests at 200/page, plus at most one token
// refresh. Zoho allows 100 req/min per org, so a single pull is comfortable;
// it is the REFRESH FREQUENCY that eats the daily quota, which is why the route
// in ./route.ts caches this result rather than calling it per visitor.
// ---------------------------------------------------------------------------
async function fetchStock(config: ZohoConfig): Promise<StockSnapshot> {
  const token = await getAccessToken(config);
  const items: Record<string, StockEntry> = Object.create(null);
  const itemsById: Record<string, StockEntry> = Object.create(null);
  let seen = 0;
  let page = 1;
  let truncated = false;

  for (;;) {
    const body = await fetchPage(config, page, token);
    const batch = Array.isArray(body.items) ? body.items : [];

    for (const item of batch) {
      seen += 1;
      const { q, s } = readStock(item, config.lowStockAt);
      const entry: StockEntry = { q, s, n: item.name };
      if (item.sku) entry.k = item.sku;
      if (item.item_id) entry.id = String(item.item_id);

      // item_id is unique per Zoho item — no dedupe question, always index it.
      if (item.item_id) itemsById[String(item.item_id)] = entry;

      const key = normalizeName(item.name);
      if (!key) continue;
      // Duplicate names in Zoho: keep the one with stock, so a live SKU is never
      // masked by a stale duplicate sitting at zero.
      const prev = items[key];
      if (!prev || (prev.q || 0) < (q || 0)) items[key] = entry;
    }

    const hasMore = Boolean(body.page_context && body.page_context.has_more_page);
    if (!hasMore || batch.length === 0) break;
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    page += 1;
  }

  return {
    items,
    itemsById,
    count: Object.keys(items).length,
    idCount: Object.keys(itemsById).length,
    seen,
    truncated,
    pages: page,
    lowStockAt: config.lowStockAt,
  };
}

/** Build an `InventorySource` backed by Zoho Inventory. */
export function createZohoSource(env: unknown): InventorySource {
  return {
    fetchStock: () => fetchStock(readZohoConfig(env)),
  };
}
