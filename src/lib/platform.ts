// iPhone app: which phone this is. Restock's screens are the same on Android and iPhone; what differs is
// underneath (android/ is Java, the iPhone's side is src/ios/). Anything an iPhone can't do stays on
// the screen, greyed, with "Why is this greyed out?" (ui/IosWhy.tsx).
import { Capacitor } from '@capacitor/core';

/** The iPhone app (not the iPhone web app from a Restock server, which is a web page). */
export const isIos = (): boolean => Capacitor.getPlatform() === 'ios';
/** The Android app. */
export const isAndroid = (): boolean => Capacitor.getPlatform() === 'android';

/** "the Android app" / "the iPhone app": for a line that says where something works. */
export const appWords = (): string => (isIos() ? 'the iPhone app' : 'the Android app');

/** Thrown by the iPhone side for something only Android can do, or that isn't built for iPhone yet. */
export class IosUnavailable extends Error {
  constructor(what = 'This') {
    super(`${what} isn't available on iPhone.`);
    this.name = 'IosUnavailable';
  }
}
