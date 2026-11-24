// iPhone app: something an iPhone can't do (or doesn't do yet) stays where it is on the screen, greyed,
// in one box with "Why is this unavailable?" along its bottom edge (IosBox). Tapping that says why.
import { useState, type ReactNode } from 'react';
import { isIos } from '../lib/platform';
import { Icon, Sheet } from './components';

export type IosReason = 'importData' | 'updates' | 'serverExtras' | 'webSignIn' | 'icloud' | 'sync' | 'server' | 'homeAssistant' | 'shopPage' | 'appIcon' | 'widgets' | 'priceHelper' | 'background';

/** Why each thing is greyed on an iPhone: a heading and what to do instead. */
export const IOS_REASONS: Record<IosReason, { title: string; why: string; instead?: string }> = {
  // 0.13.2: the one reason that's the same on every phone (shown on Android too).
  importData: {
    title: 'Import runs on a Restock server',
    why: "Import adds products and price history from an export file, such as one from another household. It's done on a Restock server's web page (Your data, then Import), where the whole household gets what's added.",
    instead: 'To bring your own data onto this phone, use Restore from a backup, just above.',
  },
  updates: {
    title: "Restock can't update itself on an iPhone",
    why: "Apple doesn't allow an app to download and install its own updates. On an iPhone, updates only come through the App Store or TestFlight, or by installing the new version from a computer.",
    instead: 'Each new version is on the Restock page on GitHub, with how to install it.',
  },
  serverExtras: {
    title: "Receipts and loyalty cards aren't shared from an iPhone yet",
    why: 'On Android, Restock can move receipt photos to your server and share loyalty cards with the house. That part is being rebuilt for iPhone and iPad. Until then they stay on this device, and nothing about them is sent.',
    instead: 'Your pantry, shopping list, inventory and prices are shared now.',
  },
  webSignIn: {
    title: "Signing in on a computer by scanning isn't on iPhone yet",
    why: "On Android, scanning the code on your server's sign-in page signs that computer in without typing the passphrase. That is being rebuilt for iPhone and iPad.",
    instead: "Until then, sign in on the computer with the server's user name and passphrase.",
  },
  icloud: {
    title: "This build of Restock can't open a folder in Files",
    why: 'iCloud sync keeps your household in a folder in iCloud Drive, and opening that folder needs a part of the app this build was made without.',
    instead: 'Install the newest Restock for iPhone and iPad and it will be here.',
  },
  sync: {
    title: "Syncing with an Android phone isn't in this build yet",
    why: "An Android phone can keep listening for the household's other phones in the background. iOS doesn't let an app do that, so an iPhone can only reach out to an Android phone while Restock is open. That part is being built for iPhone and iPad.",
    instead: 'Two iPhones can never share straight over Wi-Fi this way, because neither can listen. For iPhones, iCloud sync is the way.',
  },
  server: {
    title: "Joining a Restock server isn't in this build yet",
    why: "The part of Restock that talks to your server was written for Android and is being rebuilt for iPhone and iPad.",
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

/**
 * "Why is this unavailable?": the strip along the bottom of a greyed thing's box, and the sheet it opens.
 * With a label of its own ("Why can't I pick a time?") it's a plain link, for something that works
 * differently and isn't greyed. Nothing on Android or the web.
 */
export function IosWhy({ reason, always, label }: { reason: IosReason; /** Show it off an iPhone too (the tests, and a preview). */ always?: boolean; /** For something that works differently and isn't greyed ("Why can't I pick a time?"). */ label?: string }) {
  const [open, setOpen] = useState(false);
  if (!isIos() && !always) return null;
  const r = IOS_REASONS[reason];
  return (
    <>
      <button type="button" className={label ? 'linkish ios-why-link' : 'ios-why'} onClick={() => setOpen(true)}>
        {!label && <Icon name="info" size={16} />}
        <span className="grow">{label ?? 'Why is this unavailable?'}</span>
        <Icon name="chevron" size={label ? 14 : 16} />
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
 * A greyed thing and its "Why is this unavailable?" in one box, so the question plainly belongs to it.
 * Off an iPhone it's just the children.
 */
export function IosBox({ reason, children, always }: { reason: IosReason; children: ReactNode; always?: boolean }) {
  if (!isIos() && !always) return <>{children}</>;
  return (
    <div className="ios-box">
      {children}
      <IosWhy reason={reason} always={always} />
    </div>
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
      <span style={{ fontSize: 13 }}>Everything on this screen is unavailable until it is.</span>
      <IosWhy reason={reason} />
    </div>
  );
}
