import stylesCss from '../../public/assets/styles.css';
import appJs from '../../public/assets/app.js';
import { SECURITY_HEADERS } from '../lib/http';
import { addRoute } from '../routes/router';

/**
 * Dashboard static assets served by the Worker itself (bundled via esbuild
 * `?raw` imports) — one source of truth, works in tests, `wrangler dev` and
 * production without any external asset pipeline.
 */
export function registerAssetRoutes(): void {
  addRoute('GET', '/assets/styles.css', () =>
    new Response(stylesCss, {
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    }),
  );
  addRoute('GET', '/assets/app.js', () =>
    new Response(appJs, {
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/javascript; charset=utf-8',
        // Always revalidate the SPA router so a deploy cannot leave browsers
        // running stale navigation code.
        'Cache-Control': 'no-cache',
      },
    }),
  );
}
