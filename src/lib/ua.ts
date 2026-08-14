/**
 * Minimal privacy-conscious user-agent classification.
 * Only coarse categories are derived — no fingerprinting data is kept.
 */

export interface UaInfo {
  device: string;
  browser: string;
  os: string;
}

export function classifyUserAgent(ua: string | null): UaInfo {
  if (!ua) return { device: 'Unknown', browser: 'Unknown', os: 'Unknown' };
  const s = ua;
  let device = 'Desktop';
  let os = 'Unknown';
  let browser = 'Unknown';

  // Device
  if (/ipad|tablet/i.test(s) || (/(android|ios)/i.test(s) && !/mobile/i.test(s))) device = 'Tablet';
  else if (/iphone|ipod|android.*mobile|mobile|windows phone|blackberry/i.test(s)) device = 'Mobile';
  else if (/smarttv|tv/i.test(s)) device = 'TV';
  else if (/bot|crawler|spider|slurp|bingpreview/i.test(s)) device = 'Bot';

  // OS
  if (/windows nt 10/i.test(s)) os = 'Windows';
  else if (/windows nt 6\.[1-3]/i.test(s)) os = 'Windows';
  else if (/android/i.test(s)) os = 'Android';
  else if (/iphone|ipod|ios/i.test(s)) os = 'iOS';
  else if (/ipad/i.test(s)) os = 'iPadOS';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/linux/i.test(s)) os = 'Linux';
  else if (/cros/i.test(s)) os = 'ChromeOS';

  // Browser
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/chrome\//i.test(s) && !/edg\//i.test(s)) browser = 'Chrome';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/safari\//i.test(s) && !/chrome\//i.test(s)) browser = 'Safari';
  else if (/msie|trident/i.test(s)) browser = 'Internet Explorer';
  else if (/curl|wget|python-requests|okhttp/i.test(s)) browser = 'CLI';

  return { device, browser, os };
}

/** Extract a privacy-friendly referrer (hostname only). */
export function cleanReferrer(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host.length === 0 || host.length > 253) return null;
    return host;
  } catch {
    return null;
  }
}
