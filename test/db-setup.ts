import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { inject } from 'vitest';

declare module 'vitest' {
  interface ProvidedContext {
    migrations: D1Migration[];
  }
}

/**
 * Applies the SQL migrations (provided by test/global-setup.ts from the Node
 * side) to the in-memory D1 database once per test file.
 */
let applied = false;

export async function applyMigrations(): Promise<void> {
  if (applied) return;
  applied = true;
  const migrations = inject('migrations');
  await applyD1Migrations(env.DB, migrations);
}
