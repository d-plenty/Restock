import { mkdirSync, writeFileSync } from 'fs';
import { it } from 'vitest';
import { MIGRATIONS } from '../../src/lib/sql/schema';

it('writes the database layout for the Java sync check', () => {
  mkdirSync('tools/sync-test/out', { recursive: true });
  writeFileSync('tools/sync-test/out/migrations.json', JSON.stringify(MIGRATIONS));
});
