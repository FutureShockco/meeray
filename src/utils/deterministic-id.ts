import crypto from 'crypto';

/**
 * Generate a deterministic id from arbitrary stringifiable parts.
 * Returns a hex string of length `len` (default 16).
 */
export function deterministicIdFrom(parts: Array<string | number | bigint>, len = 16): string {
    const joined = parts.map(p => String(p)).join('|');
    const hash = crypto.createHash('sha256').update(joined).digest('hex');
    return hash.substring(0, len);
}

/**
 * Deterministic node identifier derived from an optional seed (env var or other stable input).
 * Falls back to a short sha of the hostname or process.pid when seed is not provided.
 */
export function deterministicNodeIdentifier(seed?: string, len = 8): string {
    const base = seed || process.env.STEEM_ACCOUNT || `${process.pid}`;
    const hash = crypto.createHash('sha256').update(base).digest('hex');
    return hash.substring(0, len);
}

export default { deterministicIdFrom, deterministicNodeIdentifier };
