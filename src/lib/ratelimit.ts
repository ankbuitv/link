import type { Env } from '../types';

/**
 * Rate limiting.
 *
 * Two tiers:
 *  - In-memory (per isolate): fast, used for the general API abuse limit.
 *  - KV-backed (global across regions): used for login attempts and mail
 *    sending, where cross-region consistency matters more than latency.
 */

interface WindowEntry {
  count: number;
  resetAt: number;
}

const mem = new Map<string, WindowEntry>();

/** In-memory sliding-fixed-window limiter. */
export function memoryCheck(key: string, limit: number, windowSeconds: number): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = mem.get(key);
  if (!entry || entry.resetAt <= now) {
    mem.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowSeconds * 1000 };
  }
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count++;
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}

/** KV-backed limiter (globally consistent). */
export async function kvCheck(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const kvKey = `rl:${key}:${Math.floor(now / windowSeconds)}`;
  try {
    const current = Number((await env.KV.get(kvKey)) || 0);
    if (current >= limit) {
      return { allowed: false, remaining: 0, resetAt: (Math.floor(now / windowSeconds) + 1) * windowSeconds };
    }
    await env.KV.put(kvKey, String(current + 1), { expirationTtl: windowSeconds * 2 });
    return { allowed: true, remaining: Math.max(0, limit - current - 1), resetAt: (Math.floor(now / windowSeconds) + 1) * windowSeconds };
  } catch {
    // KV unavailable — fail open rather than blocking the whole app.
    return { allowed: true, remaining: limit, resetAt: now + windowSeconds };
  }
}

export function clientIp(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const fwd = request.headers.get('X-Forwarded-For');
  if (fwd) return fwd.split(',')[0]!.trim();
  return 'unknown';
}

/** Build a scoped key with client IP. */
export function ipKey(scope: string, request: Request): string {
  return `${scope}:${clientIp(request)}`;
}
