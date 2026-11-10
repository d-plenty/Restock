import { mkdirSync, writeFileSync } from 'fs';
import { it } from 'vitest';
import { MIGRATIONS } from '../../src/lib/sql/schema';

it('writes the database layout for the Java sync check', () => {
  mkdirSync('tools/sync-test/out', { recursive: true });
  writeFileSync('tools/sync-test/out/migrations.json', JSON.stringify(MIGRATIONS));
  // 0.9.3: the layouts older versions have (migrations are only ever added), for the old-phone check.
  for (const [tag, n] of [['base090', 18], ['base091', 19], ['v092', 19]] as const) {
    mkdirSync(`tools/sync-test/out/old-${tag}`, { recursive: true });
    writeFileSync(`tools/sync-test/out/old-${tag}/migrations.json`, JSON.stringify(MIGRATIONS.slice(0, n)));
  }
});
