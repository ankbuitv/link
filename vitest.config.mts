import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  // Read the SQL migrations on the Node side (the worker-side test isolate
  // cannot access the host filesystem) and provide them to the tests.
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // In-memory D1/KV for tests; migrations applied via test/db-setup.ts
          bindings: {
            APP_NAME: 'Link Center',
            APP_URL: 'https://link.ankb.qzz.io',
            BREVO_API_KEY: 'xkeysib-test-fake-key',
            BREVO_SENDER_EMAIL: 'test@link.ankb.qzz.io',
            BREVO_SENDER_NAME: 'Test Sender',
            BREVO_WEBHOOK_SECRET: 'test-webhook-secret',
            CLICK_SALT: 'test-click-salt',
            BREVO_API_BASE_URL: 'https://api.brevo.com/v3',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      provide: { migrations },
      maxWorkers: 2,
      minWorkers: 1,
    },
  };
});
