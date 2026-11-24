// The iPhone app: the pieces that can be held to account without an iPhone.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IOS_CHECK_EVERY_HOURS, iosCheckDue } from '../lib/check';
import { IosUnavailable } from '../lib/platform';
import { IOS_REASONS } from '../ui/IosWhy';
import { RestockIos } from './native';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('iPhone app: price checks happen when Restock is opened', () => {
  const base = { sync: { backgroundActivity: true } } as Parameters<typeof iosCheckDue>[0];
  const now = Date.parse('2026-11-24T10:00:00Z');
  it('due with no check yet, or one older than 12 hours; not sooner', () => {
    expect(IOS_CHECK_EVERY_HOURS).toBe(12);
    expect(iosCheckDue({ ...base }, now)).toBe(true);
    expect(iosCheckDue({ ...base, lastCheck: '2026-11-23T21:59:00Z' }, now)).toBe(true);
    expect(iosCheckDue({ ...base, lastCheck: '2026-11-24T04:00:00Z' }, now)).toBe(false);
    expect(iosCheckDue({ ...base, lastCheck: 'nonsense' }, now)).toBe(true);
  });
  it('never when automatic checks are off', () => {
    expect(iosCheckDue({ ...base, checkDays: [] }, now)).toBe(false);
    expect(iosCheckDue({ sync: { backgroundActivity: false } } as Parameters<typeof iosCheckDue>[0], now)).toBe(false);
  });
  it('the check runs on the iPhone itself, and Home says when the next one is', () => {
    const check = read('../lib/check.ts');
    expect(check).toMatch(/if \(isIos\(\)\) \{\s*try \{\s*const r = await checkBySearch\(onProgress\);/);
    expect(check).toMatch(/if \(isIos\(\)\) return \{ due: iosCheckDue\(settings\) \};/);
    expect(read('../ui/screens/Home.tsx')).toContain("if (isIos()) return 'when you next open Restock';");
  });
});

describe("iPhone app: its side of the phone's interface", () => {
  const ios = new RestockIos();
  it('says plainly what an iPhone cannot do', async () => {
    await expect(ios.installUpdate()).rejects.toBeInstanceOf(IosUnavailable);
    await expect(ios.openStore()).rejects.toThrow(/isn't available on iPhone/);
    for (const m of ['syncJoin', 'syncNow', 'syncSetWifi', 'syncJoinServer', 'syncStartHousehold'])
      await expect((ios as unknown as Record<string, () => Promise<unknown>>)[m]()).rejects.toBeInstanceOf(IosUnavailable);
  });
  it('answers the things asked at start-up without failing', async () => {
    expect(await ios.syncInfo()).toEqual({ paired: false, batteryExempt: true });
    expect(await ios.scheduleChecks()).toEqual({ scheduled: false, due: false });
    expect(await ios.takeLaunchAction()).toEqual({});
    expect(await ios.getInsets()).toEqual({ top: 0, bottom: 0 });
    expect(await ios.haHasToken()).toEqual({ saved: false });
    expect(await ios.syncServerPoll()).toEqual({ received: 0 });
    await expect(ios.scheduleRecalls()).resolves.toBeUndefined();
    await expect(ios.updateWidgets()).resolves.toBeUndefined();
  });
  it('is only loaded on an iPhone, and Android still finds its own by name', () => {
    const native = read('../lib/sql/native.ts');
    expect(native).toMatch(/registerPlugin<RestockNativePlugin>\('RestockNative', \{\s*ios: \(\) => import\('\.\.\/\.\.\/ios\/native'\)/);
    expect(read('../lib/boot.ts')).toContain('if (Capacitor.isNativePlatform() && !isIos()) {');
  });
});

describe('iPhone app: greyed out, with why', () => {
  it('every reason has a heading and an explanation in plain words', () => {
    for (const [k, r] of Object.entries(IOS_REASONS)) {
      expect(r.title.length, k).toBeGreaterThan(10);
      expect(r.why.length, k).toBeGreaterThan(40);
    }
    expect(IOS_REASONS.updates.why).toContain("Apple doesn't allow an app to download and install its own updates");
  });
  it('updates stay on the screen greyed; sync, server and Home Assistant say they are not there yet', () => {
    const settings = read('../ui/screens/Settings.tsx');
    expect(settings).toMatch(/if \(isIos\(\)\)\s*return \(\s*<>\s*<div className="card ios-greyed" aria-disabled="true">[\s\S]{0,500}<IosWhy reason="updates" \/>/);
    expect(read('../ui/screens/Sync.tsx')).toContain('<NotHereBanner reason="sync"');
    expect(read('../ui/screens/RestockServer.tsx')).toContain('<NotHereBanner reason="server"');
    expect(read('../ui/screens/HomeAssistant.tsx')).toContain('<NotHereBanner reason="homeAssistant"');
    expect(read('../ui/IosWhy.tsx')).toContain("{label ?? 'Why is this greyed out?'}");
  });
  it('the price check setting is reworded, not greyed', () => {
    const settings = read('../ui/screens/Settings.tsx');
    expect(settings).toContain('Check prices when I open Restock');
    expect(settings).toContain('<IosWhy reason="background" label="Why can’t I pick a time?" />');
  });
  it('nothing changes off an iPhone: sync, updates and Home Assistant are where they were on Android', () => {
    expect(read('../lib/sync.ts')).toContain('export const syncAvailable = () => (Capacitor.isNativePlatform() && !isIos()) || !!demoSync();');
    expect(read('../lib/updates.ts')).toContain('export const SELF_UPDATE = !import.meta.env.VITE_FDROID && !isIos();');
  });
});

describe('iPhone app: the project and its build', () => {
  const plist = read('../../ios/App/App/Info.plist');
  const flow = read('../../.github/workflows/ios.yml');
  it('asks for the camera, location and photos in plain words, and shows its backups in Files', () => {
    for (const k of ['NSCameraUsageDescription', 'NSLocationWhenInUseUsageDescription', 'NSPhotoLibraryUsageDescription', 'UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace']) expect(plist).toContain(k);
  });
  it('has the same app ID as Android and runs on iOS 15 and later', () => {
    const proj = read('../../ios/App/App.xcodeproj/project.pbxproj');
    expect(proj).toContain('PRODUCT_BUNDLE_IDENTIFIER = family.plenty.restock;');
    expect(proj).toContain('IPHONEOS_DEPLOYMENT_TARGET = 15.0;');
  });
  it('the GitHub build signs nothing and holds no keys', () => {
    expect(flow).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(flow).toContain('unsigned.ipa');
    expect(flow).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(flow).not.toMatch(/P12|PROVISION|APPLE_ID|password/i);
  });
  it('the install page carries the warnings', () => {
    const doc = read('../../docs/IPHONE.md');
    for (const w of ['stops opening after 7 days', 'You need a computer', 'Back up first', 'unofficial', 'Why is this greyed']) expect(doc).toContain(w);
  });
});
