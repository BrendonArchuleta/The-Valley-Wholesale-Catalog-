'use strict';

/**
 * Zoho Inventory adapter.
 *
 * This is the ONLY file that knows Zoho exists. When The Valley admin console
 * replaces Zoho Inventory, rewrite `fetchStock()` to hit the new source and
 * return the same shape — nothing else in the catalog changes.
 *
 * Returns: { items: { "<normalized item name>": Entry }, itemsById: { "<zoho item_id>": Entry },
 *            count, truncated }
 *   Entry = { q: number|null, s: 'in'|'low'|'out'|'na', k?: sku, id?: item_id, n: display name }
 *
 * itemsById is the preferred join key when the catalog export carries a Zoho Item
 * ID column — it is immune to the name-formatting drift that name matching is not
 * (mixed "flavor after a dash" vs "flavor as its own pipe segment" conventions cost
 * this catalog a ~17-point match-rate hit; see README "Join key").
 */

const DC = (process.env.ZOHO_DC || 'com').replace(/^\./, '');
const ACCOUNTS_HOST = `https://accounts.zoho.${DC}`;
const API_HOST = `https://www.zohoapis.${DC}`;

const PER_PAGE = 200;
const MAX_PAGES = 60; // hard stop: 12,000 items. Guards against a pagination bug burning the daily API quota.
const LOW_STOCK_AT = Number(process.env.LOW_STOCK_THRESHOLD || 6);

// ---------------------------------------------------------------------------
// Access token cache (module scope — survives across invocations on a warm
// Vercel instance, so we are not burning a token call on every request).
// ---------------------------------------------------------------------------
let tokenCache = { value: null, expiresAt: 0 };
let tokenInFlight = null;

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    const params = new URLSearchParams({
      refresh_token: requiredEnv('ZOHO_REFRESH_TOKEN'),
      client_id: requiredEnv('ZOHO_CLIENT_ID'),
      client_secret: requiredEnv('ZOHO_CLIENT_SECRET'),
      grant_type: 'refresh_token',
    });

    const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token?${params}`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || !body.access_token) {
      throw new Error(
        `Zoho token refresh failed (HTTP ${res.status}): ${body.error || JSON.stringify(body).slice(0, 200)}`
      );
    }

    // Zoho returns expires_in in seconds (typically 3600). Retire it 5 min early.
    const ttlMs = (Number(body.expires_in) || 3600) * 1000;
    tokenCache = { value: body.access_token, expiresAt: Date.now() + ttlMs - 5 * 60 * 1000 };
    return tokenCache.value;
  })().finally(() => {
    tokenInFlight = null;
  });

  return tokenInFlight;
}

// ---------------------------------------------------------------------------
// Name normalization — the join key between the catalog CSV and Zoho.
// Must match the client-side `normalize()` in stock-badges.js exactly.
// ---------------------------------------------------------------------------
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/–|—/g, '-') // en/em dash -> hyphen
    .replace(/[’‘]/g, "'")
    .replace(/\s*\|\s*/g, '|') // collapse spacing around pipes
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// One page of items, with retry on 429 / 5xx.
// ---------------------------------------------------------------------------
async function fetchPage(page, token, attempt = 0) {
  const params = new URLSearchParams({
    organization_id: requiredEnv('ZOHO_ORG_ID'),
    page: String(page),
    per_page: String(PER_PAGE),
    filter_by: 'Status.Active',
  });

  const res = await fetch(`${API_HOST}/inventory/v1/items?${params}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 3) throw new Error(`Zoho items page ${page} failed after retries (HTTP ${res.status})`);
    const waitMs = Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchPage(page, token, attempt + 1);
  }

  if (res.status === 401 && attempt === 0) {
    // Token went stale mid-run — force a refresh once.
    tokenCache = { value: null, expiresAt: 0 };
    const fresh = await getAccessToken();
    return fetchPage(page, fresh, attempt + 1);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Zoho items page ${page} failed (HTTP ${res.status}): ${body.message || 'unknown error'}`);
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
function readStock(item) {
  // Explicitly untracked items (services, non-inventory rows) have no meaningful
  // stock number — do not fabricate one.
  if (item.track_inventory === false) return { q: null, s: 'na' };

  const raw = [item.available_stock, item.actual_available_stock, item.stock_on_hand].find(
    (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))
  );

  if (raw === undefined) return { q: null, s: 'na' };

  const q = Math.max(0, Math.floor(Number(raw) || 0));
  const s = q <= 0 ? 'out' : q <= LOW_STOCK_AT ? 'low' : 'in';
  return { q, s };
}

// ---------------------------------------------------------------------------
// Full pull.
// ~2,972 active items = ~15 requests at 200/page. Zoho allows 100 req/min per
// org, so a single pull is comfortable; it is the REFRESH FREQUENCY that eats
// the daily quota. See README "Call budget".
// ---------------------------------------------------------------------------
async function fetchStock() {
  const token = await getAccessToken();
  const items = Object.create(null); // keyed by normalized name
  const itemsById = Object.create(null); // keyed by Zoho item_id (stable, no formatting drift)
  let seen = 0;
  let page = 1;
  let truncated = false;

  for (;;) {
    const body = await fetchPage(page, token);
    const batch = Array.isArray(body.items) ? body.items : [];

    for (const item of batch) {
      seen += 1;
      const { q, s } = readStock(item);
      const entry = { q, s, n: item.name };
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

    const hasMore = body.page_context && body.page_context.has_more_page;
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
  };
}

module.exports = { fetchStock, normalizeName, LOW_STOCK_AT };
