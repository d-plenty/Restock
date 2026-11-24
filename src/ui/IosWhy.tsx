// iPhone app: the iPhone app. Something an iPhone can't do (or doesn't do yet) stays where it is on the
// screen, greyed, with "Why is this greyed out?" under it. Tapping that says why, in a small box.
import { useState, type ReactNode } from 'react';
import { isIos } from '../lib/platform';
import { Icon, Sheet } from './components';

export type IosReason = 'updates' | 'sync' | 'server' | 'homeAssistant' | 'shopPage' | 'appIcon' | 'widgets' | 'priceHelper' | 'background';

/** Why each thing is greyed on an iPhone: a heading and what to do instead. */
export const IOS_REASONS: Record<IosReason, { title: string; why: string; instead?: string }> = {
  updates: {
    title: "Restock can't update itself on an iPhone",
    why: "Apple doesn't allow an app to download and install its own updates. On an iPhone, updates only come through the App Store or TestFlight, or by installing the new version from a computer.",
    instead: 'Each new version is on the Restock page on GitHub, with how to install it.',
  },
  sync: {
    title: "Phone sharing isn't on iPhone yet",
    why: "Sharing straight between phones on your Wi-Fi was written for Android, where Restock can keep listening for the other phones in the background. iOS doesn't let an app do that the same way, so it has to be built again for iPhone. It's planned.",
    instead: 'Until then, a backup file made on one phone can be restored on another (Settings → Sync and backups → Backups).',
  },
  server: {
    title: "Joining a Restock server isn't on iPhone yet",
    why: "The part of Restock that talks to your server was written for Android and is being rebuilt for iPhone. It's the next thing planned for the iPhone app.",
    instead: "Until then, your server's own web page works on an iPhone: open its address in Safari and add it to your home screen.",
  },
  homeAssistant: {
    title: "Home Assistant isn't on iPhone yet",
    why: 'Home Assistant sync was written for Android and is being rebuilt for iPhone, after sync with a Restock server.',
  },
  shopPage: {
    title: "A shop's own page can't open inside Restock on an iPhone yet",
    why: "On Android, Restock opens the shop's website in its own built-in browser, so you can sign in, pick your branch or pass the shop's \"are you a person\" check, and Restock can then use that visit. That built-in browser is being rebuilt for iPhone.",
    instead: 'Searching and price checks still work for shops that answer without it.',
  },
  appIcon: {
    title: "The app icon can't be changed here yet",
    why: 'Changing the icon works differently on an iPhone and is being rebuilt for it.',
  },
  widgets: {
    title: "Home screen widgets aren't on iPhone yet",
    why: 'iPhone widgets are a separate small program that has to be written for iOS. They are planned for after the main app is finished.',
  },
  priceHelper: {
    title: 'A price helper phone has to be an Android phone',
    why: 'A price helper searches the shops through the week while it sits on its charger. iOS stops apps doing that kind of work in the background.',
  },
  background: {
    title: "An iPhone can't check prices at a set time",
    why: "iOS decides when an app may do anything in the background, and doesn't let it choose a time. So Restock checks prices when you open it, when the last check is more than 12 hours old.",
    instead: 'Check now on Home checks straight away, any time.',
  },
};

/** "Why is this greyed out?": the line under a greyed thing, and the box it opens. Nothing on Android or the web. */
export function IosWhy({ reason, always, label }: { reason: IosReason; /** Show it off an iPhone too (the tests, and a preview). */ always?: boolean; /** For something that works differently and isn't greyed ("Why can't I pick a time?"). */ label?: string }) {
  const [open, setOpen] = useState(false);
  if (!isIos() && !always) return null;
  const r = IOS_REASONS[reason];
  return (
    <>
      <button type="button" className="linkish ios-why" onClick={() => setOpen(true)}>
        {label ?? 'Why is this greyed out?'} <Icon name="chevron" size={14} />
      </button>
      {open && (
        <Sheet title={r.title} onClose={() => setOpen(false)}>
          <p style={{ margin: 0 }}>{r.why}</p>
          {r.instead && (
            <p className="small" style={{ margin: 0 }}>
              {r.instead}
            </p>
          )}
          <button className="btn primary block" onClick={() => setOpen(false)}>
            OK
          </button>
        </Sheet>
      )}
    </>
  );
}

/**
 * A banner for a whole screen that isn't on iPhone yet ("Phone sharing isn't on iPhone yet"), with the
 * why. Off an iPhone it's the words the screen already had for the web preview.
 */
export function NotHereBanner({ reason, title, preview }: { reason: IosReason; /** Off an iPhone: "Sync works in the Android app". */ title: string; preview?: ReactNode }) {
  if (!isIos())
    return (
      <div className="banner grey">
        <strong>{title}</strong>
        <span style={{ fontSize: 13 }}>{preview ?? 'In this preview everything stays in this browser.'}</span>
      </div>
    );
  return (
    <div className="banner grey ios-not-here">
      <strong>{IOS_REASONS[reason].title}</strong>
      <span style={{ fontSize: 13 }}>Everything on this screen is greyed out until it is.</span>
      <IosWhy reason={reason} />
    </div>
  );
}
