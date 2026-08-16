/**
 * Exercises /api/stock against a mocked Zoho Inventory and a mocked Workers
 * Cache API. No credentials, no network.
 *
 *   node --experimental-strip-types --test tests/stock-route.test.mts
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ---------------------------------------------------------------------------
// Mock Zoho
// ---------------------------------------------------------------------------

const CREDS = {
  ZOHO_CLIENT_ID: "1000.test",
  ZOHO_CLIENT_SECRET: "secret",
  ZOHO_REFRESH_TOKEN: "1000.refresh",
  ZOHO_ORG_ID: "123456789",
};

interface ZohoStub {
  items: Record<string, unknown>[];
  /** Requests seen, in order. */
  calls: string[];
  tokenCalls: number;
  pageCalls: number;
  /** Fail every items request with this HTTP status until cleared. */
  failWith?: number;
  /** Return 401 exactly once on the Nth items page (1-indexed). */
  expireTokenOnPage?: number;
  perPage: number;
}

function makeItems(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    item_id: `900000${String(i).padStart(6, "0")}`,
    name: `Brand ${i} | ELiquid | 100ml | 3mg | Flavor ${i}`,
    sku: `SKU-${i}`,
    available_stock: i % 4 === 0 ? 42 : i % 4 === 1 ? 3 : i % 4 === 2 ? 0 : 7,
    ...(i % 4 === 3 ? { track_inventory: false } : {}),
  }));
}

function installZohoStub(stub: ZohoStub): () => void {
  const original = globalThis.fetch;
  const expired = new Set<number>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    stub.calls.push(url);

    if (url.includes("/oauth/v2/token")) {
      stub.tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `tok-${stub.tokenCalls}`, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/inventory/v1/items")) {
      stub.pageCalls += 1;
      const page = Number(new URL(url).searchParams.get("page") || "1");

      if (stub.failWith) {
        return new Response(JSON.stringify({ message: "boom" }), { status: stub.failWith });
      }
      if (stub.expireTokenOnPage === page && !expired.has(page)) {
        expired.add(page);
        return new Response(JSON.stringify({ message: "expired" }), { status: 401 });
      }

      const start = (page - 1) * stub.perPage;
      const slice = stub.items.slice(start, start + stub.perPage);
      return new Response(
        JSON.stringify({
          items: slice,
          page_context: { has_more_page: start + stub.perPage < stub.items.length },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// Mock Workers Cache API. `store` is shared across "isolates" on purpose — that
// is the property the caching design depends on.
// ---------------------------------------------------------------------------

function installCache(store: Map<string, string>): () => void {
  const previous = (globalThis as Record<string, unknown>).caches;

  (globalThis as Record<string, unknown>).caches = {
    default: {
      async match(request: Request) {
        const body = store.get(request.url);
        return body === undefined
          ? undefined
          : new Response(body, { headers: { "content-type": "application/json" } });
      },
      async put(request: Request, response: Response) {
        store.set(request.url, await response.text());
      },
    },
  };

  return () => {
    (globalThis as Record<string, unknown>).caches = previous;
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let isolateSeed = 0;

/** Load a fresh copy of the route + adapter, so their module-scope caches are
 *  empty — the moral equivalent of a cold isolate. */
async function coldIsolate() {
  const v = `?isolate=${isolateSeed++}`;
  const route = await import(`../worker/inventory/route.ts${v}`);
  const zoho = await import(`../worker/inventory/zoho.ts${v}`);
  const source = await import(`../worker/inventory/source.ts${v}`);
  return { route, zoho, source };
}

const waited: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    waited.push(p);
  },
};

async function settleBackgroundWork() {
  await Promise.allSettled(waited.splice(0));
}

function req(method = "GET", url = "https://catalog.test/api/stock") {
  return new Request(url, { method });
}

const FAST = { ttlSeconds: 1800, swrSeconds: 3600, retainSeconds: 21600 };

// ---------------------------------------------------------------------------

test("paginates every item and mints exactly one token", async () => {
  const stub: ZohoStub = { items: makeItems(3330), calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200 };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const res = await route.handleStockRequest(req(), ctx, zoho.createZohoSource(CREDS), FAST);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(stub.pageCalls, 17, "3330 items / 200 per page = 17 pages");
    assert.equal(stub.tokenCalls, 1);
    assert.equal(body.count, 3330);
    assert.equal(body.id_count, 3330);
    assert.equal(body.truncated, false);
    assert.equal(body.ok, true);
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("buckets in / low / out / na and strips display names from the wire", async () => {
  const stub: ZohoStub = {
    items: [
      { item_id: "1", name: "In Stock Item", sku: "A", available_stock: 42 },
      { item_id: "2", name: "Low Stock Item", sku: "B", available_stock: 6 },
      { item_id: "3", name: "Out Item", sku: "C", available_stock: 0 },
      { item_id: "4", name: "Service Item", sku: "D", track_inventory: false, available_stock: 99 },
      { item_id: "5", name: "Unknown Item", sku: "E" },
    ],
    calls: [],
    tokenCalls: 0,
    pageCalls: 0,
    perPage: 200,
  };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const res = await route.handleStockRequest(req(), ctx, zoho.createZohoSource(CREDS), FAST);
    const body = await res.json();

    assert.equal(body.low_stock_at, 6);
    assert.deepEqual(body.itemsById["1"], { q: 42, s: "in", k: "A", id: "1" });
    assert.deepEqual(body.itemsById["2"], { q: 6, s: "low", k: "B", id: "2" }, "at the threshold is low, not in");
    assert.deepEqual(body.itemsById["3"], { q: 0, s: "out", k: "C", id: "3" });
    assert.deepEqual(body.itemsById["4"], { q: null, s: "na", k: "D", id: "4" }, "untracked never reports a number");
    assert.deepEqual(body.itemsById["5"], { q: null, s: "na", k: "E", id: "5" });

    for (const entry of Object.values(body.itemsById) as Record<string, unknown>[]) {
      assert.ok(!("n" in entry), "display name must not ship over the wire");
    }
    assert.ok(body.items["in stock item"], "name-keyed fallback map is populated");
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("duplicate names keep the in-stock record, but both survive in itemsById", async () => {
  const stub: ZohoStub = {
    items: [
      { item_id: "dead", name: "Same Name", available_stock: 0 },
      { item_id: "live", name: "Same Name", available_stock: 25 },
    ],
    calls: [],
    tokenCalls: 0,
    pageCalls: 0,
    perPage: 200,
  };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const body = await (
      await route.handleStockRequest(req(), ctx, zoho.createZohoSource(CREDS), FAST)
    ).json();

    assert.equal(body.count, 1, "one name key");
    assert.equal(body.items["same name"].id, "live", "the zero-stock twin must not mask the live SKU");
    assert.equal(body.id_count, 2, "id map indexes both, independent of name dedupe");
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("re-authenticates on a mid-run 401 and still completes", async () => {
  const stub: ZohoStub = {
    items: makeItems(600),
    calls: [],
    tokenCalls: 0,
    pageCalls: 0,
    perPage: 200,
    expireTokenOnPage: 2,
  };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const res = await route.handleStockRequest(req(), ctx, zoho.createZohoSource(CREDS), FAST);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.count, 600);
    assert.equal(stub.tokenCalls, 2, "one initial mint plus one forced refresh");
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("a warm isolate serves from memory with zero upstream calls", async () => {
  const stub: ZohoStub = { items: makeItems(400), calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200 };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const source = zoho.createZohoSource(CREDS);

    await route.handleStockRequest(req(), ctx, source, FAST);
    const afterFirst = stub.pageCalls;

    const second = await route.handleStockRequest(req(), ctx, source, FAST);
    assert.equal(stub.pageCalls, afterFirst, "no extra upstream calls");
    assert.equal(second.headers.get("x-stock-source"), "memory");
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("a cold isolate reuses the shared cache instead of re-pulling", async () => {
  const stub: ZohoStub = { items: makeItems(400), calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200 };
  const store = new Map<string, string>();
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(store);
  try {
    const first = await coldIsolate();
    await first.route.handleStockRequest(req(), ctx, first.zoho.createZohoSource(CREDS), FAST);
    const afterFirst = stub.pageCalls;
    assert.ok(afterFirst > 0);
    assert.equal(store.size, 1, "the pull was written to the shared cache");

    // A brand-new isolate: empty module scope, same colo cache.
    const second = await coldIsolate();
    const res = await second.route.handleStockRequest(req(), ctx, second.zoho.createZohoSource(CREDS), FAST);

    assert.equal(stub.pageCalls, afterFirst, "visitor traffic must never reach Zoho directly");
    assert.equal(res.headers.get("x-stock-source"), "cache");
    assert.equal((await res.json()).count, 400);
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("the client's ?t= cache-buster does not spend the upstream budget", async () => {
  const stub: ZohoStub = { items: makeItems(400), calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200 };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const source = zoho.createZohoSource(CREDS);
    await route.handleStockRequest(req(), ctx, source, FAST);
    const afterFirst = stub.pageCalls;

    await route.handleStockRequest(req("GET", "https://catalog.test/api/stock?t=1699999999"), ctx, source, FAST);
    assert.equal(stub.pageCalls, afterFirst);
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("past TTL it answers immediately and refreshes behind the response", async () => {
  const stub: ZohoStub = { items: makeItems(400), calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200 };
  const store = new Map<string, string>();
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(store);
  try {
    const { route, zoho } = await coldIsolate();
    const source = zoho.createZohoSource(CREDS);
    await route.handleStockRequest(req(), ctx, source, FAST);
    const afterFirst = stub.pageCalls;

    // Age the stored copy past TTL but inside the SWR window.
    const aged = JSON.parse(store.get([...store.keys()][0])!);
    aged.generated_at = new Date(Date.now() - (FAST.ttlSeconds + 60) * 1000).toISOString();
    store.set([...store.keys()][0], JSON.stringify(aged));

    const cold = await coldIsolate();
    const res = await cold.route.handleStockRequest(req(), ctx, cold.zoho.createZohoSource(CREDS), FAST);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-stock-source"), "revalidating");
    assert.equal(stub.pageCalls, afterFirst, "the visitor did not wait on the refresh");

    await settleBackgroundWork();
    assert.ok(stub.pageCalls > afterFirst, "the refresh did run, after the response");
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("an upstream outage serves the last good data flagged stale", async () => {
  const stub: ZohoStub = { items: makeItems(400), calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200 };
  const store = new Map<string, string>();
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(store);
  try {
    const { route, zoho } = await coldIsolate();
    const source = zoho.createZohoSource(CREDS);
    await route.handleStockRequest(req(), ctx, source, FAST);

    // Age the copy beyond the SWR window so the next request must go upstream.
    const key = [...store.keys()][0];
    const aged = JSON.parse(store.get(key)!);
    const oldStamp = new Date(Date.now() - (FAST.ttlSeconds + FAST.swrSeconds + 60) * 1000).toISOString();
    aged.generated_at = oldStamp;
    store.set(key, JSON.stringify(aged));

    stub.failWith = 500;
    const cold = await coldIsolate();
    const res = await cold.route.handleStockRequest(req(), ctx, cold.zoho.createZohoSource(CREDS), FAST);
    const body = await res.json();

    assert.equal(res.status, 200, "a Zoho outage must not break the catalog");
    assert.equal(res.headers.get("x-stock-source"), "stale");
    assert.equal(body.stale, true);
    assert.equal(body.stale_since, oldStamp);
    assert.equal(body.count, 400, "the badges are old, not gone");
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("a cold failure returns no badges rather than false out-of-stock", async () => {
  const stub: ZohoStub = { items: [], calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200, failWith: 500 };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const res = await route.handleStockRequest(req(), ctx, zoho.createZohoSource(CREDS), FAST);
    const body = await res.json();

    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.deepEqual(body.items, {});
    assert.deepEqual(body.itemsById, {});
    assert.equal(body.count, 0);
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("missing credentials degrade to no badges, not a crash", async () => {
  const stub: ZohoStub = { items: makeItems(10), calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200 };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const res = await route.handleStockRequest(req(), ctx, zoho.createZohoSource({}), FAST);

    assert.equal(res.status, 503);
    assert.equal((await res.json()).ok, false);
    assert.equal(stub.calls.length, 0, "never even tried to reach Zoho");
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("sets CDN cache headers and rejects non-GET", async () => {
  const stub: ZohoStub = { items: makeItems(10), calls: [], tokenCalls: 0, pageCalls: 0, perPage: 200 };
  const restoreZoho = installZohoStub(stub);
  const restoreCache = installCache(new Map());
  try {
    const { route, zoho } = await coldIsolate();
    const source = zoho.createZohoSource(CREDS);

    const ok = await route.handleStockRequest(req(), ctx, source, FAST);
    assert.equal(
      ok.headers.get("cache-control"),
      "public, max-age=0, s-maxage=1800, stale-while-revalidate=3600"
    );
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");

    const post = await route.handleStockRequest(req("POST"), ctx, source, FAST);
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  } finally {
    restoreCache();
    restoreZoho();
  }
});

test("the server and browser name normalizers agree", async () => {
  const { source } = await coldIsolate();
  const normalizeName = source.normalizeName as (s: unknown) => string;

  // Pull the client's normalize() straight out of the shipped asset so the two
  // cannot silently drift apart.
  const client = await readFile(new URL("../public/stock-badges.js", import.meta.url), "utf8");
  const body = client.slice(client.indexOf("function normalize(name)"));
  const clientSource = body.slice(0, body.indexOf("\n  }") + 4);
  const clientNormalize = new Function(`${clientSource}; return normalize;`)() as (s: unknown) => string;

  const samples = [
    "Cloud Nurdz | ELiquid | 100ml | 3mg | Blue Razz",
    "7 Stax  |  80mg | MIT | 15ct Bottle | 1200mg- Blue Razz",
    "Brand – Flavor — Two",
    "It’s a ‘Test’",
    "  MIXED   Case  ",
    "",
  ];

  for (const sample of samples) {
    assert.equal(normalizeName(sample), clientNormalize(sample), `normalizers disagree on: ${sample}`);
  }
});
