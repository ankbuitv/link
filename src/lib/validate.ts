/**
 * Input validation helpers. All user-supplied values are validated here.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX = 254;

export function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 3 || v.length > EMAIL_MAX) return false;
  if (!EMAIL_RE.test(v)) return false;
  // No control characters or spaces allowed.
  if (/[\s<>()[\]\\,;:]/.test(v)) return false;
  return true;
}

/** Parse a list of recipients from comma/newline separated text. */
export function parseRecipients(raw: unknown): { emails: string[]; errors: string[] } {
  const emails: string[] = [];
  const errors: string[] = [];
  if (typeof raw !== 'string') return { emails, errors: ['Recipients are required.'] };
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,;]+/)) {
    const email = part.trim();
    if (!email) continue;
    if (isValidEmail(email)) {
      const key = email.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        emails.push(email);
      }
    } else {
      errors.push(`"${email}" is not a valid email address.`);
    }
  }
  if (emails.length === 0 && errors.length === 0) errors.push('At least one recipient is required.');
  return { emails, errors };
}

/**
 * Validate a destination URL. Only http/https are allowed — everything else
 * (javascript:, data:, file:, vbscript:, ftp:...) is rejected so the redirect
 * system can never be used as an open proxy for dangerous schemes.
 */
export function validateDestinationUrl(raw: unknown): { url: string | null; error: string | null } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { url: null, error: 'Destination URL is required.' };
  }
  const v = raw.trim();
  if (v.length > 2048) return { url: null, error: 'Destination URL is too long.' };
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return { url: null, error: 'Destination URL is not valid.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: null, error: 'Only http:// and https:// destinations are allowed.' };
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    return { url: null, error: 'Destination URL must include a valid hostname.' };
  }
  return { url: v, error: null };
}

/** Simple string length clamp helper. */
export function clampString(v: unknown, max: number, label: string): { value: string; error: string | null } {
  if (typeof v !== 'string') return { value: '', error: `${label} is required.` };
  const s = v.trim();
  if (s.length === 0) return { value: '', error: `${label} is required.` };
  if (s.length > max) return { value: '', error: `${label} must be at most ${max} characters.` };
  return { value: s, error: null };
}

export function optionalString(v: unknown, max: number): { value: string | null; error: string | null } {
  if (v === undefined || v === null) return { value: null, error: null };
  if (typeof v !== 'string') return { value: null, error: 'Expected a string.' };
  const s = v.trim();
  if (s.length === 0) return { value: null, error: null };
  if (s.length > max) return { value: null, error: `Must be at most ${max} characters.` };
  return { value: s, error: null };
}

export function optionalInt(v: unknown, min: number, max: number, fallback: number | null): number | null {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Coerce a boolean-ish value. */
export function toBool(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}
