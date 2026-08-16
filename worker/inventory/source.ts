/**
 * The contract every inventory source must satisfy.
 *
 * Nothing in this file knows or cares which system the numbers came from. The
 * caching route (`./route.ts`) imports only from here, so replacing Zoho
 * Inventory with the internal admin console means writing one new module that
 * returns a `StockSnapshot` and changing the single wiring line in
 * `worker/index.ts` — the route, the cache, and the browser payload are
 * untouched.
 */

/** `na` = the source does not track stock for this item, so render no badge. */
export type StockStatus = "in" | "low" | "out" | "na";

export interface StockEntry {
  /** Available quantity, or null when the source does not track it. */
  q: number | null;
  s: StockStatus;
  /** SKU, when the source has one. */
  k?: string;
  /** The source's own item id — the join key the catalog rows carry. */
  id?: string;
  /** Display name. Stripped before the payload goes over the wire. */
  n?: string;
}

export interface StockSnapshot {
  /** Keyed by normalized display name — the fallback join. */
  items: Record<string, StockEntry>;
  /** Keyed by the source's item id — the primary join. */
  itemsById: Record<string, StockEntry>;
  count: number;
  idCount: number;
  seen: number;
  truncated: boolean;
  pages: number;
  /** At or below this quantity an item badges as "Low stock". */
  lowStockAt: number;
}

export interface InventorySource {
  fetchStock(): Promise<StockSnapshot>;
}

/**
 * Name normalization — the fallback join key between the catalog and the
 * inventory source.
 *
 * Must stay byte-for-byte equivalent to `normalize()` in
 * `public/stock-badges.js`. If you change one, change both.
 */
export function normalizeName(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/–|—/g, "-") // en/em dash -> hyphen
    .replace(/[’‘]/g, "'")
    .replace(/\s*\|\s*/g, "|") // collapse spacing around pipes
    .replace(/\s+/g, " ")
    .trim();
}
