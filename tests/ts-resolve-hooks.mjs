/**
 * Lets `node --test` load the Worker's TypeScript directly.
 *
 * The Worker sources use bundler-style extensionless imports (`./source`),
 * which Vite and the Workers build resolve but Node's ESM loader does not.
 * This hook fills in the `.ts` extension so the tests exercise the exact files
 * that ship, instead of a transpiled copy that could drift.
 */

import { existsSync } from "node:fs";

const HAS_EXTENSION = /\.[cm]?[jt]sx?$/;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const [path, query] = specifier.split("?");
    if (!HAS_EXTENSION.test(path) && context.parentURL) {
      const candidate = new URL(`${path}.ts`, context.parentURL);
      if (existsSync(candidate)) {
        return nextResolve(`${path}.ts${query ? `?${query}` : ""}`, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
