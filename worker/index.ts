/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleStockRequest, readStockRouteOptions } from "./inventory/route";
import { createZohoSource } from "./inventory/zoho";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };

  // Live inventory. The four ZOHO_* values are secrets set in the Site's
  // settings; the rest are optional tuning. All absent in local dev unless a
  // .dev.vars file supplies them, in which case /api/stock reports itself
  // unavailable and the catalog simply renders no badges.
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_REFRESH_TOKEN?: string;
  ZOHO_ORG_ID?: string;
  ZOHO_DC?: string;
  LOW_STOCK_THRESHOLD?: string;
  STOCK_TTL_SECONDS?: string;
  STOCK_SWR_SECONDS?: string;
  STOCK_RETAIN_SECONDS?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const assetUrl = new URL("/catalog.html", request.url);
      const assetResponse = await env.ASSETS.fetch(
        new Request(assetUrl, {
          method: request.method,
          headers: request.headers,
        }),
      );

      if (assetResponse.ok) {
        const headers = new Headers(assetResponse.headers);
        headers.set("content-type", "text/html; charset=utf-8");
        headers.set("x-content-type-options", "nosniff");
        headers.set("referrer-policy", "strict-origin-when-cross-origin");

        if (request.method === "HEAD") {
          return new Response(null, { status: assetResponse.status, headers });
        }

        const html = (await assetResponse.text()).replaceAll(
          "__SITE_ORIGIN__",
          url.origin,
        );
        return new Response(html, { status: assetResponse.status, headers });
      }
    }

    // Live stock for the catalog's variant badges. Swapping Zoho Inventory for
    // the internal admin console is a change to this one line plus a new module
    // implementing InventorySource — the route and its caching stay put.
    if (url.pathname === "/api/stock") {
      return handleStockRequest(request, ctx, createZohoSource(env), readStockRouteOptions(env));
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
