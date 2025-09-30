import cache from '../cache.js';
import logger from '../logger.js';

type CacheEntry = {
  value: any;
  expiresAt: number;
};

const ttlMs = 60 * 1000; // 60s default TTL
const store = new Map<string, CacheEntry>();

export async function getToken(symbol: string): Promise<any | null> {
  try {
    const key = symbol?.toString();
    if (!key) return null;
    const now = Date.now();
    const existing = store.get(key);
    if (existing && existing.expiresAt > now) return existing.value;

    // Miss or expired — fetch from cache (which is backed by mongo/cache layer)
    const token = await cache.findOnePromise('tokens', { symbol: key }) || await cache.findOnePromise('tokens', { _id: key });
    if (token) {
      store.set(key, { value: token, expiresAt: now + ttlMs });
    }
    return token || null;
  } catch (err) {
    logger.debug(`[tokenCache] Error fetching token ${symbol}: ${err}`);
    return null;
  }
}

export function setToken(symbol: string, tokenDoc: any): void {
  try {
    if (!symbol || !tokenDoc) return;
    store.set(symbol.toString(), { value: tokenDoc, expiresAt: Date.now() + ttlMs });
  } catch (err) {
    logger.debug(`[tokenCache] Error setting token ${symbol}: ${err}`);
  }
}

export function invalidateToken(symbol: string): void {
  if (!symbol) return;
  store.delete(symbol.toString());
}

export function preloadAll(tokens: any[]): void {
  const now = Date.now();
  for (const t of tokens || []) {
    const key = t?.symbol || t?._id;
    if (key) store.set(key.toString(), { value: t, expiresAt: now + ttlMs });
  }
}

export default { getToken, setToken, invalidateToken, preloadAll };
