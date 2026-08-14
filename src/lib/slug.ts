/**
 * Cryptographically secure random slug generation + custom slug validation.
 * Uses crypto.getRandomValues with rejection sampling.
 */

// Unambiguous alphabet (no 0/O/1/l/I to avoid confusion when read aloud).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const ALPHABET_LEN = ALPHABET.length;

export const DEFAULT_SLUG_LENGTH = 10;
export const MAX_SLUG_LENGTH = 64;

/**
 * Route prefixes owned by the application. These can never be used as a
 * custom slug so a link can never shadow application routes.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'dashboard',
  'go',
  'health',
  'link',
  'links',
  'login',
  'logout',
  'mail',
  'r',
  'robots.txt',
  'setup',
  'settings',
  'static',
  'track',
  'webhook',
]);

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Generate a random slug of the given length (default 10). */
export function randomSlug(length: number = DEFAULT_SLUG_LENGTH): string {
  if (length < 4 || length > MAX_SLUG_LENGTH) length = DEFAULT_SLUG_LENGTH;
  const out = new Uint8Array(length);
  // Rejection sampling: fill bytes using values below the largest multiple
  // of ALPHABET_LEN so the distribution stays uniform.
  const limit = 256 - (256 % ALPHABET_LEN);
  let filled = 0;
  const buf = new Uint8Array(64);
  while (filled < length) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && filled < length; i++) {
      const v = buf[i]!;
      if (v < limit) {
        out[filled] = ALPHABET.charCodeAt(v % ALPHABET_LEN);
        filled++;
      }
    }
  }
  return String.fromCharCode(...out);
}

/** Validate a custom slug. Returns an error message or null when valid. */
export function validateCustomSlug(slug: string): string | null {
  if (typeof slug !== 'string' || slug.length === 0) return 'Slug is required.';
  if (slug.length < 2) return 'Slug must be at least 2 characters.';
  if (slug.length > MAX_SLUG_LENGTH) return `Slug must be at most ${MAX_SLUG_LENGTH} characters.`;
  if (!SLUG_RE.test(slug)) {
    return 'Slug may only contain letters, numbers, "-" and "_" (and must start with a letter or number).';
  }
  if (RESERVED_SLUGS.has(slug.toLowerCase())) {
    return `"${slug}" is a reserved route and cannot be used.`;
  }
  return null;
}

/**
 * Resolve the requested slug (or throw) for a public path segment.
 * Normalizes: strips trailing slash, case-insensitive reserved checks are
 * handled by the registry — here we just validate shape.
 */
export function sanitizePublicSlug(segment: string): string {
  if (!segment) return '';
  if (segment.length > MAX_SLUG_LENGTH) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return '';
  return segment;
}
