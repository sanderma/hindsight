import { ProxyAgent, fetch as undiciFetch } from "undici";
import { createClient, createConfig, type HindsightClient } from "@vectorize-io/hindsight-client";

function buildProxyFetch(proxyUrl: string): typeof globalThis.fetch {
  const dispatcher = new ProxyAgent(proxyUrl);
  return (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as unknown as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>;
}

/**
 * Replaces the internal generated HTTP client inside a HindsightClient instance
 * with one that routes all requests through the given proxy URL. This is scoped
 * to the single plugin instance and does not affect globalThis.fetch or any
 * other network calls in the process.
 */
export function injectProxyFetch(
  client: HindsightClient,
  baseUrl: string,
  apiKey: string | undefined,
  proxyUrl: string
): void {
  const proxyFetch = buildProxyFetch(proxyUrl);
  const headers: Record<string, string> = {
    // Mirror what HindsightClient sets so proxy requests are identifiable.
    // DEFAULT_USER_AGENT isn't exported by the published package, so we use
    // the package name as a stable fallback.
    "User-Agent": "hindsight-client-typescript",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  // The generated @hey-api client stored in `this.client` supports a custom
  // fetch via createConfig. We reach it via `any` because HindsightClient
  // declares the field private — the property name is stable in the compiled
  // output (not minified) and covered by the plugin's own tests.
  (client as any).client = createClient(createConfig({ baseUrl, headers, fetch: proxyFetch }));
}
