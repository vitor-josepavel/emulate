import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "./http.js";

/**
 * Request header selecting the state namespace an emulator operates on.
 *
 * Every namespace owns a private copy of the store. A namespace seen for the
 * first time is forked from the default namespace, so it starts with the seed
 * data (API keys, catalog, fixtures) and diverges from there. Requests without
 * the header use the default namespace.
 *
 * This lets many isolated test runs share one emulator process: each run sends
 * its own namespace and never sees the resources another run created.
 */
export const NAMESPACE_HEADER = "x-emulate-namespace";

export const DEFAULT_NAMESPACE = "";

const storage = new AsyncLocalStorage<string>();

export function currentNamespace(): string {
  return storage.getStore() ?? DEFAULT_NAMESPACE;
}

export function runInNamespace<T>(namespace: string, fn: () => T): T {
  return storage.run(namespace, fn);
}

export function namespaceMiddleware(): MiddlewareHandler {
  return (c, next) => {
    const namespace = c.req.header(NAMESPACE_HEADER);
    if (!namespace) return next();
    return runInNamespace(namespace, next);
  };
}
