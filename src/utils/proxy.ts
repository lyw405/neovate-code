/**
 * HTTP Proxy utilities for AI model providers
 * Handles proxy configuration and custom fetch implementation
 */

import { ProxyAgent } from 'undici';

// Module-level cache for ProxyAgent instances (one per unique proxy URL)
const proxyAgents = new Map<string, ProxyAgent>();

// Module-level cache for undici fetch
let undiciFetch: typeof import('undici').fetch | null = null;

/**
 * Create a custom fetch function that uses the specified proxy
 * This wraps undici's fetch with the ProxyAgent
 *
 * Why needed: Bun's native fetch doesn't support HTTP_PROXY env vars,
 * so we use undici's fetch with ProxyAgent to handle proxy requests
 *
 * @param proxyUrl - Proxy URL (e.g., http://127.0.0.1:7890 or socks5://127.0.0.1:1080)
 * @returns A fetch-compatible function that routes requests through the configured proxy
 * @example
 * const proxyFetch = createProxyFetch('http://127.0.0.1:7890');
 * await proxyFetch('https://api.openai.com/v1/models');
 */
export function createProxyFetch(proxyUrl: string) {
  // Get or create ProxyAgent for this URL
  let proxyAgent = proxyAgents.get(proxyUrl);

  if (!proxyAgent) {
    try {
      proxyAgent = new ProxyAgent(proxyUrl);
      proxyAgents.set(proxyUrl, proxyAgent);
    } catch (error) {
      console.error(
        `[Proxy] Failed to create ProxyAgent for ${proxyUrl}:`,
        error,
      );
      // Return native fetch as fallback
      return fetch;
    }
  }

  // Return a fetch-compatible function
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    // Lazy load undici fetch (cached at module level)
    if (!undiciFetch) {
      undiciFetch = (await import('undici')).fetch;
    }

    // Convert input to URL string for undici
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input);

    // undici fetch with ProxyAgent dispatcher
    return undiciFetch(url, {
      ...init,
      dispatcher: proxyAgent!,
    } as any);
  };
}
