// @vitest-environment jsdom
// 0.15.1: each version of the app says only what belongs in it (docs/STORES.md).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { appChannel, SELF_UPDATE, setChannel } from '../../lib/updates';
import { show, screen } from '../../test/screen';
import { ComingSoon } from './Soon';

const titles = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');

describe('Coming soon, in each version', () => {
  afterEach(() => setChannel('github'));
  test('the APK: F-Droid, and the iPhone app from a computer', async () => {
    setChannel('github');
    expect(SELF_UPDATE).toBe(true);
    await show(<ComingSoon />);
    // 0.18.1: the official app stores, F-Droid's main repository and Running low (no iPhone widgets on Android)
    expect(titles()).toEqual(['The App Store and Google Play: more about it', 'F-Droid: more about it', 'Running low: more about it']);
  });
  test('Google Play: no other app store, and no updater', async () => {
    setChannel('play');
    expect(appChannel()).toBe('play');
    expect(SELF_UPDATE).toBe(false);
    await show(<ComingSoon />);
    expect(titles()).not.toContain('F-Droid: more about it');
    expect(titles()).not.toContain('The App Store and Google Play: more about it');
  });
  test('the App Store: nothing about installing from a computer', async () => {
    setChannel('appstore');
    await show(<ComingSoon />);
    expect(document.body.textContent).not.toMatch(/from a computer|F-Droid/);
    expect(titles()).toEqual(['Widgets on iPhone and iPad: more about it', 'Running low: more about it']);
  });
});

describe('the Google Play version is built without the updater', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  test('its manifest takes out installing apps and the background question', () => {
    const m = read('../../../android/app/src/play/AndroidManifest.xml');
    for (const p of ['REQUEST_INSTALL_PACKAGES', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS']) expect(m).toContain(`<uses-permission android:name="android.permission.${p}" tools:node="remove" />`);
  });
  test('the native side refuses to install an update, and asks for the battery list instead', () => {
    const java = read('../../../android/app/src/main/java/family/plenty/restock/RestockNativePlugin.java');
    expect(java).toMatch(/if \(!BuildConfig\.SELF_UPDATE\) \{\s*call\.reject\("This version of Restock is updated by Google Play\."\)/);
    expect(java).toContain('Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    const gradle = read('../../../android/app/build.gradle');
    expect(gradle).toMatch(/play \{\s*dimension "channel"\s*buildConfigField "boolean", "SELF_UPDATE", "false"/);
  });
});
