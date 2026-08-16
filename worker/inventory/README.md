# Live inventory (`/api/stock`)

Pulls stock from Zoho Inventory and serves it to the catalog, which renders
**In stock / Low stock / Out of stock** badges on each variant row.

```
Browser → /api/stock (this Worker, cached ~30 min) → Zoho Inventory API
```

Zoho credentials never reach the browser. The catalog calls one same-origin
endpoint; this Worker holds the tokens.

## Layout

| File | What it is |
|---|---|
| `source.ts` | The `InventorySource` contract + the shared name normalizer. Knows nothing about Zoho. |
| `zoho.ts` | The only file that knows Zoho exists — OAuth refresh, pagination, stock bucketing. |
| `route.ts` | The endpoint: caching, staleness, error fallback, response shape. Source-agnostic. |
| `../index.ts` | Routes `/api/stock` and picks the source (one line). |
| `../../public/stock-badges.js` | Browser badge layer, served at `/stock-badges.js`. No dependencies. |

**Replacing Zoho with the admin console:** add a module next to `zoho.ts` that
exports a `createXSource(env): InventorySource` returning a `StockSnapshot`, then
change the one `createZohoSource(env)` call in `worker/index.ts`. The route, the
caching, the payload shape, and the catalog stay as they are.

## Configuration

Set these in **chatgpt.com/sites → this Site → More actions → Settings →
environment variables and secrets**. This project is hosted by ChatGPT Sites
(see `.openai/hosting.json`), not by a Cloudflare account you control directly,
so `wrangler secret put` and the Cloudflare dashboard do not apply.

| Name | | Value |
|---|---|---|
| `ZOHO_CLIENT_ID` | secret | Self Client id from api-console.zoho.com |
| `ZOHO_CLIENT_SECRET` | secret | Self Client secret |
| `ZOHO_REFRESH_TOKEN` | secret | Long-lived; does not expire unless revoked |
| `ZOHO_ORG_ID` | secret | The **Inventory** org id, not the CRM one |

The OAuth scope is `ZohoInventory.items.READ` — this integration never writes.

Optional tuning (plain variables, not secrets):

| Name | Default | Notes |
|---|---|---|
| `ZOHO_DC` | `com` | `com`, `eu`, `in`, `com.au`, `jp`, `ca`, `com.cn`, `sa` |
| `LOW_STOCK_THRESHOLD` | `6` | At or below this count an item badges "Low stock" |
| `STOCK_TTL_SECONDS` | `1800` | How long a pull counts as fresh. **Read the call budget first.** |
| `STOCK_SWR_SECONDS` | `3600` | Window past TTL where we answer instantly and refresh in the background |
| `STOCK_RETAIN_SECONDS` | `21600` | How long the last good pull is kept for the outage fallback |

Redeploy after adding them — the Worker reads them at request time, but the
values are only attached to a new deployment.

For local development, put the same names in a `.dev.vars` file at the repo root
(git-ignored). Without it, `/api/stock` returns 503 and the catalog renders no
badges, which is the correct degraded behavior.

## Verifying

```bash
curl -sS -D- https://<your-site>/api/stock | head -c 600
```

Working:

```
HTTP/2 200
cache-control: public, max-age=0, s-maxage=1800, stale-while-revalidate=3600
x-stock-source: upstream

{"ok":true,"generated_at":"2026-08-16T00:00:00.000Z","stale":false,
 "low_stock_at":6,"count":3330,"id_count":3330,"truncated":false,
 "items":{"7 stax|80mg|mit|15ct bottle|1200mg- blue razz":{"q":42,"s":"in","k":"...","id":"8117889000004406263"}},
 "itemsById":{"8117889000004406263":{"q":42,"s":"in","k":"..."}}}
```

`x-stock-source` says which layer answered:

| Value | Meaning |
|---|---|
| `upstream` | Went to Zoho just now |
| `memory` | Warm isolate, no Zoho call |
| `cache` | Colo cache, no Zoho call — the common case |
| `revalidating` | Served instantly, refreshing behind the response |
| `stale` | Zoho is failing; this is the last good pull |
| `error` | Nothing cached and Zoho unreachable — catalog renders no badges |

Spot-check one item id against Zoho, then load the catalog and confirm badges
appear on variant rows. `id_count` should be ~3,330 and comfortably above the
2,828 rows the catalog carries.

**If `x-stock-source: error`:** credentials are missing or wrong. The Worker log
line `[api/stock] inventory pull failed: …` names which.

## Call budget

A full pull is ~17-18 Zoho calls (3,330 active items ÷ 200 per page, plus a
token refresh). Zoho allows 100 requests/minute per org and a daily cap set by
your plan. This is *total*, not per visitor — the cache serves every shopper
from one pull.

| `STOCK_TTL_SECONDS` | Pulls/day | Zoho calls/day |
|---|---|---|
| `300` (5 min) | 288 | ~5,200 — will blow most plans |
| `900` (15 min) | 96 | ~1,730 |
| **`1800` (30 min, default)** | 48 | **~865 — safe on every paid plan** |
| `3600` (60 min) | 24 | ~430 |

Cloudflare's cache is per-colo, so the real figure is that table multiplied by
the number of colos serving traffic — for a US wholesale catalog, a handful.
Check Zoho Inventory → Settings → Developer Space → API Usage before lowering
the TTL.

## Design decisions

**Item ID is the primary join key; name is the fallback.** The payload is keyed
both ways. The catalog's variant rows carry `data-item-id`, matched 1:1 against
the Zoho export. Name matching alone scored 83.4% on this catalog because the
CSV mixes two flavor-naming conventions and only one lines up with Zoho.

**`available_stock`, not `stock_on_hand`.** Available is on-hand minus quantity
committed to open sales orders — the number a rep would actually quote.

**Untracked items get no badge.** `track_inventory: false` returns status `na`
and renders nothing. A missing badge is honest; a false "Out of stock" costs a
sale.

**An outage degrades, it doesn't break.** The last good pull is retained and
served flagged `stale`. If there has never been a successful pull, the response
carries zero items and the catalog renders no badges — the same experience as
before this integration existed.

**Out-of-stock items stay orderable.** The order is a request, not a receipt;
the rep confirms availability.

**Publishing exact quantities raises the bar on the inventory disclaimer.**
Suggested wording for the order pad and PDF:

> Stock levels shown are refreshed periodically and are not a reservation.
> Quantities can change between browsing and order confirmation — your rep
> confirms availability before anything is final.

## Tests

```bash
npm run test:stock
```

13 tests against a mocked Zoho and a mocked Cache API — pagination, token
refresh, mid-run 401 re-auth, stock bucketing, duplicate-name dedupe, all three
cache layers, stale-while-revalidate, outage fallback, cold failure, and that
the server and browser name normalizers still agree.
