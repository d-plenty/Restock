import { describe, expect, it } from 'vitest';
import { updateWaiting } from './UpdateBanner';

describe('0.10.12: Home says an update is waiting until it is installed', () => {
  it('shows the newer version the last check found', () => {
    expect(updateWaiting({ notify: true, told: '0.10.13' }, '0.10.12')).toBe('0.10.13');
    expect(updateWaiting({ notify: false, told: '0.11.0' }, '0.10.12')).toBe('0.11.0');
  });
  it('goes once this app is that version or newer', () => {
    expect(updateWaiting({ notify: true, told: '0.10.12' }, '0.10.12')).toBeUndefined();
    expect(updateWaiting({ notify: true, told: '0.10.11' }, '0.10.12')).toBeUndefined();
  });
  it('shows nothing when no check has found one, or what was kept is not a version', () => {
    expect(updateWaiting(undefined, '0.10.12')).toBeUndefined();
    expect(updateWaiting({ notify: true }, '0.10.12')).toBeUndefined();
    expect(updateWaiting({ notify: true, told: '<b>9</b>' }, '0.10.12')).toBeUndefined();
  });
});
