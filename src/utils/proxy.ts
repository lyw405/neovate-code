/**
 * HTTP Proxy utilities for AI model providers
 * Handles proxy configuration and custom fetch implementation
 */

import { ProxyAgent } from 'undici';

let currentProxyUrl: string | null = null;
let proxyAgent: ProxyAgent | null = null;

/**
 * Setup proxy configuration using undici ProxyAgent
 *
 * Why this is needed:
 * - Bun's native fetch doesn't support HTTP_PROXY environment variables
 * - We use undici's ProxyAgent to enable proxy support for AI SDK requests
 * - Environment variables are set for compatibility with libraries that check them
 *
 * @param proxyUrl - Proxy URL (e.g., http://127.0.0.1:7890 or socks5://127.0.0.1:1080)
 * @example
 * setupProxyEnv('http://127.0.0.1:7890');
 */
export function setupProxyEnv(proxyUrl: string): void {
  // Skip if already set to avoid redundant operations
  if (currentProxyUrl === proxyUrl) {
    return;
  }

  // Create ProxyAgent for undici-based fetch
  try {
    proxyAgent = new ProxyAgent(proxyUrl);
  } catch (error) {
    console.error(
      `[Proxy] Failed to create ProxyAgent for ${proxyUrl}:`,
      error,
    );
    proxyAgent = null;
    return;
  }

  // Set environment variables for compatibility with libraries that check them
  // Some Node.js HTTP clients (like axios, node-fetch) respect these variables
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;

  currentProxyUrl = proxyUrl;
}

/**
 * Clear proxy configuration
 */
export function clearProxyEnv(): void {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  proxyAgent = null;
  currentProxyUrl = null;
}

/**
 * Get currently configured proxy URL
 */
export function getCurrentProxy(): string | null {
  return currentProxyUrl;
}

/**
 * Check if a proxy is currently configured
 */
export function hasProxy(): boolean {
  return currentProxyUrl !== null;
}

/**
 * Get the ProxyAgent instance for use with undici/fetch
 */
export function getProxyAgent(): ProxyAgent | null {
  return proxyAgent;
}

/**
 * Create a custom fetch function that uses the proxy
 * This wraps undici's fetch with the ProxyAgent
 *
 * Why needed: Bun's native fetch doesn't support HTTP_PROXY env vars,
 * so we use undici's fetch with ProxyAgent to handle proxy requests
 *
 * @returns A fetch-compatible function that routes requests through the configured proxy
 */
export function createProxyFetch() {
  if (!proxyAgent) {
    return fetch;
  }

  // Import undici fetch once and cache it
  let undiciFetchPromise: Promise<typeof import('undici').fetch> | null = null;
  const getUndiciFetch = async () => {
    if (!undiciFetchPromise) {
      undiciFetchPromise = import('undici').then((m) => m.fetch);
    }
    return undiciFetchPromise;
  };

  // Return a fetch-compatible function
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const undiciFetch = await getUndiciFetch();

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
