// 0.14.0: the Restock server's core still builds (npm run build:server-core). It is one bundle for
// Node with nothing from Capacitor in it; the iPhone app's own modules once came in through a
// dynamic import and broke it without any other test noticing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the Restock core for the server', () => {
  it('builds into one module with no iPhone or Capacitor plugin code in it', () => {
    const out = mkdtempSync(join(tmpdir(), 'restock-core-'));
    try {
      const r = spawnSync('npx', ['vite', 'build', '--config', 'vite.core.config.ts', '--logLevel', 'error'], { env: { ...process.env, SERVER_CORE_OUT: out }, encoding: 'utf8' });
      expect(r.status, r.stderr.slice(0, 2000)).toBe(0);
      const core = readFileSync(join(out, 'restock-core.mjs'), 'utf8');
      expect(core.length).toBeGreaterThan(100_000);
      expect(core).not.toContain('RestockApplePlugin');
      expect(core).not.toContain('@capacitor/filesystem');
      expect(core).toContain('Not on the Restock server (the iPhone and iPad app only).');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
