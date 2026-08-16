/*!
 * Valley Wholesale catalog — live stock badges
 * Drop-in client for /api/stock. No dependencies, no build step.
 *
 * INTEGRATION:
 *
 *   1. On each variant row, add the Zoho Item ID if you have it — PREFERRED,
 *      immune to name-formatting drift between the catalog export and Zoho:
 *        <div class="variant" data-item-id="910165756000012345">
 *      If you don't have the ID for a row, fall back to the full pipe-delimited
 *      name (still works, just less reliable across catalog re-exports):
 *        <div class="variant" data-item-name="Cloud Nurdz | ELiquid | 100ml | 3mg | Blue Razz">
 *      You can set both — ID is tried first, name is the fallback.
 *      The badge is appended to that element, or to a child you mark with
 *      data-stock-slot if you want it somewhere specific:
 *        <span data-stock-slot></span>
 *
 *   2. Include this file before </body>:
 *        <script src="/stock-badges.js" defer></script>
 *
 * Rows added later (expanding a product line, filtering, searching) are picked
 * up automatically — a MutationObserver re-scans on DOM changes.
 *
 * PUBLIC API (window.ValleyStock):
 *   .ready              Promise resolving to the payload once loaded
 *   .get(name)          -> { q, s, k, id, n } | null   (matches by name)
 *   .getById(id)        -> { q, s, k, id, n } | null   (matches by Zoho item_id — preferred)
 *   .status(name)       -> 'in' | 'low' | 'out' | 'na' | 'unknown'
 *   .statusById(id)      -> same, by id
 *   .qty(name)          -> number | null
 *   .qtyById(id)         -> number | null
 *   .summarize(names)   -> { total, in: n, low: n, out: n, unknown: n }  (for collapsed product-line rows)
 *   .asOf()             -> Date | null
 *   .isStale()          -> boolean
 *   .decorate(root)     Manually badge a subtree
 *   .refresh()          Force a re-fetch (bypasses the browser cache)
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/stock';
  var ATTR_ID = 'data-item-id';
  var ATTR_NAME = 'data-item-name';
  var DONE = 'data-stock-rendered';

  var state = { data: null, byName: null, byId: null, loaded: false, failed: false };

  // ---------------------------------------------------------------------
  // Must stay byte-for-byte equivalent to normalizeName() in api/_zoho.js.
  // ---------------------------------------------------------------------
  function normalize(name) {
    return String(name == null ? '' : name)
      .toLowerCase()
      .replace(/–|—/g, '-')
      .replace(/[’‘]/g, "'")
      .replace(/\s*\|\s*/g, '|')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---------------------------------------------------------------------
  // Styles — Valley brand tokens.
  // ---------------------------------------------------------------------
  var CSS = [
    '.vw-stock{display:inline-flex;align-items:center;gap:.35em;',
    'font-family:"Public Sans",system-ui,sans-serif;font-size:.72rem;font-weight:600;',
    'line-height:1;letter-spacing:.01em;padding:.32em .6em;border-radius:999px;',
    'white-space:nowrap;vertical-align:middle;border:1px solid transparent}',
    '.vw-stock__dot{width:.45em;height:.45em;border-radius:50%;background:currentColor;flex:0 0 auto}',
    '.vw-stock__qty{font-variant-numeric:tabular-nums;opacity:.85;font-weight:500}',
    '.vw-stock--in{color:#2C4F40;background:#EAF1EC;border-color:#CFE0D5}',
    '.vw-stock--low{color:#7A5C27;background:#F7EFE1;border-color:#E7D6B8}',
    '.vw-stock--out{color:#A54B3C;background:#F7EAE7;border-color:#E9CFC9}',
    '.vw-stock--stale{opacity:.75}',
    '.vw-stock-asof{font-family:"Public Sans",system-ui,sans-serif;font-size:.72rem;color:#6B6559}',
  ].join('');

  function injectStyles() {
    if (document.getElementById('vw-stock-styles')) return;
    var el = document.createElement('style');
    el.id = 'vw-stock-styles';
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  // ---------------------------------------------------------------------
  // Badge rendering
  // ---------------------------------------------------------------------
  var LABELS = { in: 'In stock', low: 'Low stock', out: 'Out of stock' };

  function buildBadge(entry, stale) {
    if (!entry || entry.s === 'na') return null;

    var badge = document.createElement('span');
    badge.className = 'vw-stock vw-stock--' + entry.s + (stale ? ' vw-stock--stale' : '');
    badge.setAttribute('role', 'status');

    var dot = document.createElement('span');
    dot.className = 'vw-stock__dot';
    dot.setAttribute('aria-hidden', 'true');
    badge.appendChild(dot);

    badge.appendChild(document.createTextNode(LABELS[entry.s] || ''));

    // Exact quantity, per Kyle's call. Suppressed on 'out' — "Out of stock · 0"
    // is noise — and on null, which means Zoho does not track that item.
    if (entry.s !== 'out' && typeof entry.q === 'number') {
      var qty = document.createElement('span');
      qty.className = 'vw-stock__qty';
      qty.textContent = '· ' + entry.q;
      badge.appendChild(qty);
    }

    var when = state.data && state.data.generated_at
      ? new Date(state.data.generated_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : null;
    badge.title =
      (typeof entry.q === 'number' ? entry.q + ' available' : LABELS[entry.s] || '') +
      (when ? ' — as of ' + when : '') +
      '. Availability is confirmed by your rep before the order is final.';

    return badge;
  }

  function decorate(root) {
    if (!state.loaded || state.failed || (!state.byName && !state.byId)) return;
    var scope = root && root.querySelectorAll ? root : document;

    var selector =
      '[' + ATTR_ID + ']:not([' + DONE + ']), [' + ATTR_NAME + ']:not([' + DONE + '])';
    var nodes = scope.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];

      // ID first — immune to name-formatting drift. Name is the fallback for
      // rows that don't carry a Zoho Item ID yet.
      var id = node.getAttribute(ATTR_ID);
      var entry = (id && state.byId && state.byId[id]) || null;
      if (!entry) {
        var nm = node.getAttribute(ATTR_NAME);
        entry = (nm && state.byName && state.byName[normalize(nm)]) || null;
      }
      node.setAttribute(DONE, entry ? entry.s : 'unknown');

      var badge = buildBadge(entry, state.data && state.data.stale);
      if (!badge) continue;

      var slot = node.querySelector('[data-stock-slot]');
      (slot || node).appendChild(badge);

      // Hook for your own styling / sort / filter logic:
      //   [data-stock-rendered="out"] { opacity:.6 }
      // Out-of-stock items stay orderable on purpose — the order is a request,
      // and the rep confirms availability.
    }
  }

  // ---------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------
  function index(source) {
    var map = Object.create(null);
    var items = source || {};
    for (var key in items) if (Object.prototype.hasOwnProperty.call(items, key)) map[key] = items[key];
    return map;
  }

  function load(force) {
    var url = force ? ENDPOINT + '?t=' + Date.now() : ENDPOINT;
    return fetch(url, { cache: force ? 'reload' : 'default' })
      .then(function (r) {
        return r.json();
      })
      .then(function (payload) {
        if (!payload || !payload.items) throw new Error('Malformed stock payload');
        state.data = payload;
        state.byName = index(payload.items);
        state.byId = index(payload.itemsById);
        state.loaded = true;
        state.failed = !payload.ok;
        injectStyles();
        decorate(document);
        document.dispatchEvent(new CustomEvent('valleystock:loaded', { detail: payload }));
        return payload;
      })
      .catch(function (err) {
        // Silent by design: no stock data means no badges, and the catalog
        // works exactly as it does today.
        state.loaded = true;
        state.failed = true;
        console.warn('[ValleyStock] live inventory unavailable:', err && err.message);
        document.dispatchEvent(new CustomEvent('valleystock:failed'));
        return null;
      });
  }

  var ready = load(false);

  // ---------------------------------------------------------------------
  // Re-badge as the catalog re-renders (expanding lines, filtering, search).
  // Batched to one pass per frame so a 2,900-row re-render stays cheap.
  // ---------------------------------------------------------------------
  var queued = false;
  function scheduleDecorate() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      decorate(document);
    });
  }

  function observe() {
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes && records[i].addedNodes.length) {
          scheduleDecorate();
          return;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  window.ValleyStock = {
    ready: ready,
    get: function (name) {
      return (state.byName && state.byName[normalize(name)]) || null;
    },
    getById: function (id) {
      return (id && state.byId && state.byId[String(id)]) || null;
    },
    status: function (name) {
      var e = this.get(name);
      return e ? e.s : 'unknown';
    },
    statusById: function (id) {
      var e = this.getById(id);
      return e ? e.s : 'unknown';
    },
    qty: function (name) {
      var e = this.get(name);
      return e && typeof e.q === 'number' ? e.q : null;
    },
    qtyById: function (id) {
      var e = this.getById(id);
      return e && typeof e.q === 'number' ? e.q : null;
    },
    // Pass either names or IDs — mixed arrays are fine, each is looked up by ID
    // first when it looks like one, falling back to name matching.
    summarize: function (namesOrIds) {
      var out = { total: 0, in: 0, low: 0, out: 0, unknown: 0 };
      for (var i = 0; i < (namesOrIds || []).length; i++) {
        var v = namesOrIds[i];
        var s = (v && state.byId && state.byId[String(v)]) ? this.statusById(v) : this.status(v);
        out.total += 1;
        if (s === 'in' || s === 'low' || s === 'out') out[s] += 1;
        else out.unknown += 1;
      }
      return out;
    },
    asOf: function () {
      return state.data && state.data.generated_at ? new Date(state.data.generated_at) : null;
    },
    isStale: function () {
      return !!(state.data && state.data.stale);
    },
    decorate: decorate,
    refresh: function () {
      return load(true);
    },
    normalize: normalize,
  };
})();
