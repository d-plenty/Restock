import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// 0.15.2: docs/PRIVACY.md and docs/TERMS.md (the web addresses the app stores ask for) are made
// from the words the app shows, and kept up to date with them.
describe('the privacy policy and fine print on GitHub', () => {
  it('say exactly what the app says', () => {
    expect(() => execFileSync('node', ['tools/legal-pages/make.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
