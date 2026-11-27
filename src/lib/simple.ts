// 0.18.1: the Simple design (Settings → Look and colours → Style). It replaced Plain. Picking it
// turns the opening animation and the holiday themes off and Less motion on, and remembers what they
// were, so going back to the default theme puts them back. It also goes easier on the phone
// (`isLite`): price checks on the iPhone and iPad take longer breaks, and charts are drawn
// plainer (0.18.2: long lists come in parts in both designs now).
import type { Settings } from '../types';

type S = Pick<Settings, 'look' | 'a11y'>;

/** The settings with Simple picked. */
export function pickSimple(s: S): Pick<Settings, 'look' | 'a11y'> {
  return {
    look: {
      ...s.look,
      style: 'simple',
      opening: false,
      holidays: false,
      simpleWas: { opening: s.look.opening !== false, holidays: s.look.holidays !== false, motion: !!s.a11y.motion },
    },
    a11y: { ...s.a11y, motion: true },
  };
}

/** The settings back on the default theme, with what Simple turned off put back as it was. */
export function leaveSimple(s: S): Pick<Settings, 'look' | 'a11y'> {
  const was = s.look.simpleWas;
  const { simpleWas: _gone, ...look } = s.look;
  if (!was) return { look: { ...look, style: 'australia' }, a11y: s.a11y };
  return {
    look: { ...look, style: 'australia', opening: was.opening ?? true, holidays: was.holidays ?? true },
    a11y: { ...s.a11y, motion: !!was.motion },
  };
}

let lite = false;
/** Simple is on: go easier on the phone. Set by lib/theme.ts with the look. */
export const isLite = (): boolean => lite;
export const setLite = (on: boolean): void => {
  lite = on;
};
