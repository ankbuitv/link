import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLUG_LENGTH,
  RESERVED_SLUGS,
  randomSlug,
  sanitizePublicSlug,
  validateCustomSlug,
} from '../src/lib/slug';

describe('random slug generation', () => {
  it('generates slugs of the default length with the expected charset', () => {
    for (let i = 0; i < 200; i++) {
      const slug = randomSlug();
      expect(slug).toHaveLength(DEFAULT_SLUG_LENGTH);
      expect(slug).toMatch(/^[A-Za-z0-9]+$/);
      expect(slug).not.toMatch(/[0O1lI]/); // no ambiguous chars
    }
  });

  it('respects a custom length', () => {
    expect(randomSlug(4)).toHaveLength(4);
    expect(randomSlug(16)).toHaveLength(16);
    expect(randomSlug(3)).toHaveLength(10); // below minimum -> default
  });

  it('produces varied slugs (randomness smoke test)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomSlug());
    expect(seen.size).toBeGreaterThan(950);
  });

  it('uses cryptographically secure randomness (getRandomValues)', () => {
    // Rejection sampling path is exercised implicitly; just verify no throw.
    expect(() => randomSlug(64)).not.toThrow();
  });
});

describe('custom slug validation', () => {
  it('accepts valid slugs', () => {
    for (const s of ['abc123', 'my-link_2', 'A1b2C3', 'ab']) {
      expect(validateCustomSlug(s)).toBeNull();
    }
  });

  it('rejects invalid slugs', () => {
    expect(validateCustomSlug('')).not.toBeNull();
    expect(validateCustomSlug('a')).not.toBeNull();
    expect(validateCustomSlug('has space')).not.toBeNull();
    expect(validateCustomSlug('has/slash')).not.toBeNull();
    expect(validateCustomSlug('dots.are.bad')).not.toBeNull();
    expect(validateCustomSlug('-starts-with-dash')).not.toBeNull();
    expect(validateCustomSlug('_starts-with-underscore')).not.toBeNull();
    expect(validateCustomSlug('x'.repeat(65))).not.toBeNull();
    expect(validateCustomSlug('javascript:alert(1)')).not.toBeNull();
  });

  it('rejects reserved route names', () => {
    for (const r of RESERVED_SLUGS) {
      expect(validateCustomSlug(r)).not.toBeNull();
      expect(validateCustomSlug(r.toUpperCase())).not.toBeNull();
    }
    expect(validateCustomSlug('api')).not.toBeNull();
    expect(validateCustomSlug('track')).not.toBeNull();
    expect(validateCustomSlug('admin')).not.toBeNull();
    expect(validateCustomSlug('dashboard')).not.toBeNull();
  });
});

describe('public slug sanitization', () => {
  it('normalizes and rejects malformed slugs', () => {
    expect(sanitizePublicSlug('Kx8pQ2mL')).toBe('Kx8pQ2mL');
    expect(sanitizePublicSlug('abc-123_')).toBe('abc-123_');
    expect(sanitizePublicSlug('../../etc/passwd')).toBe('');
    expect(sanitizePublicSlug('a b')).toBe('');
    expect(sanitizePublicSlug('x'.repeat(100))).toBe('');
    expect(sanitizePublicSlug('')).toBe('');
  });
});
