// 0.18.0: every place that names this version says the same one, so a release can't go out with one
// left behind (0.17.0's server image stopped for that reason): package.json and its lock, Android's
// versionName and versionCode, the store's changelog for that code, F-Droid's entry, the README's
// badge and New in section, and What's new.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { WHATS_NEW } from './lib/whatsNew';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version as string;
const gradle = read('android/app/build.gradle');
const code = Number(/versionCode (\d+)/.exec(gradle)?.[1]);

describe('the version, everywhere', () => {
  it('package.json, its lock and Android agree', () => {
    expect(JSON.parse(read('package-lock.json')).version).toBe(version);
    expect(gradle).toContain(`versionName "${version}"`);
    expect(code).toBeGreaterThan(0);
  });
  it('the store changelog, F-Droid, the README and What’s new have it', () => {
    expect(existsSync(new URL(`../fastlane/metadata/android/en-US/changelogs/${code}.txt`, import.meta.url))).toBe(true);
    expect(read(`fastlane/metadata/android/en-US/changelogs/${code}.txt`).length).toBeLessThanOrEqual(500);
    const fd = read('docs/fdroid/family.plenty.restock.yml');
    expect(fd).toContain(`CurrentVersion: ${version}\n`);
    expect(fd).toContain(`CurrentVersionCode: ${code}\n`);
    expect(fd).toContain(`  - versionName: ${version}\n    versionCode: ${code}\n    commit: v${version}\n`);
    const readme = read('README.md');
    expect(readme).toContain(`release%20candidate%20${version}-`);
    expect(readme).toContain(`## New in ${version}\n`);
    expect(WHATS_NEW[0].version).toBe(version);
  });
});
