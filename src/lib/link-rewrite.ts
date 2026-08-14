import { cfg } from '../config';
import type { Env } from '../types';
import { getLinkBySlug, insertLink, slugExists } from './db-links';
import { randomSlug } from './slug';
import { validateDestinationUrl } from './validate';

/**
 * Email → tracked links.
 *
 * When "Track links" is enabled while composing, every http(s) URL in the
 * HTML/text body is rewritten to  https://<app>/track/<slug>  and a `track`
 * link row is created (kind='email') associated with the email. The rewritten
 * links redirect to the original destination and record clicks, so the
 * dashboard can show  Email → Link → Clicks.
 *
 * Rewriting happens in two phases:
 *  1. prepareTrackedEmail  — plans the mapping (no DB writes),
 *  2. persistTrackedLinks  — creates the link rows (idempotent per URL),
 *  3. applyMapping         — rewrites the bodies with the final URLs.
 */

export interface UrlMapping {
  original: string;
  slug: string;
  finalUrl: string;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Extract unique http(s) URLs from a body (deduped, sanitized). */
export function extractUrls(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.match(URL_RE) || []) {
    let u = m;
    // Trim trailing punctuation that is not part of the URL.
    u = u.replace(/[.,;:!?]+$/, '');
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        if (!seen.has(u)) {
          seen.add(u);
          out.push(u);
        }
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Find an existing track link for (email, originalUrl) or build a fresh slug. */
export async function planUrlMappings(
  env: Env,
  emailId: string | null,
  campaignId: string | null,
  urls: string[],
): Promise<UrlMapping[]> {
  const mappings: UrlMapping[] = [];
  for (const original of urls) {
    let slug: string | null = null;
    // Reuse an existing email-track link for the same email + URL.
    if (emailId) {
      const rows = await env.DB.prepare(
        'SELECT slug FROM links WHERE email_id = ? AND destination_url = ? LIMIT 1',
      )
        .bind(emailId, original)
        .first<{ slug: string }>();
      if (rows) slug = rows.slug;
    }
    if (!slug) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = randomSlug(10);
        if (!(await slugExists(env, candidate))) {
          slug = candidate;
          break;
        }
      }
    }
    if (slug) {
      mappings.push({ original, slug, finalUrl: `${cfg(env).appUrl}/track/${slug}` });
    }
  }
  return mappings;
}

/** Persist the planned mappings as track links (skip ones that already exist). */
export async function persistTrackedLinks(
  env: Env,
  emailId: string,
  campaignId: string | null,
  ownerId: string | null,
  mappings: UrlMapping[],
): Promise<UrlMapping[]> {
  const persisted: UrlMapping[] = [];
  for (const m of mappings) {
    const existing = await getLinkBySlug(env, m.slug);
    if (existing) {
      persisted.push(m);
      continue;
    }
    const { url } = validateDestinationUrl(m.original);
    if (!url) continue;
    await insertLink(env, {
      slug: m.slug,
      type: 'track',
      kind: 'email',
      destinationUrl: url,
      title: null,
      ownerId,
      campaignId,
      emailId,
      status: 'active',
    });
    persisted.push(m);
  }
  return persisted;
}

/** Rewrite both bodies with the final tracked URLs. */
export function applyMapping(body: string, mapping: Map<string, string>): string {
  if (mapping.size === 0) return body;
  return body.replace(URL_RE, (match) => {
    const u = match.replace(/[.,;:!?]+$/, '');
    const replacement = mapping.get(u);
    if (!replacement) return match;
    const trailing = match.slice(u.length);
    return replacement + trailing;
  });
}
