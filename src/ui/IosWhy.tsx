// iPhone app: something an iPhone can't do (or doesn't do yet) stays where it is on the screen, greyed,
// in one box with "Why is this unavailable?" along its bottom edge (IosBox). Tapping that says why.
import { useState, type ReactNode } from 'react';
import { isIos } from '../lib/platform';
import { Icon, Sheet } from './components';

// 0.15.0: only what an iPhone build can still be without: the Files folder (an old build) and the
// shop's own page (a build without the Apple part). Everything else works on iPhone now, or says how
// it works there in its own words.
type IosReason = 'icloud' | 'shopPage';

/** Why something is greyed on an iPhone: a heading and what to do instead. */
export const IOS_REASONS: Record<IosReason, { title: string; why: string; instead?: string }> = {
  icloud: {
    title: "This build of Restock can't open a folder in Files",
    why: 'iCloud sync keeps your household in a folder in iCloud Drive, and opening that folder needs a part of the app this build was made without.',
    instead: 'Install the newest Restock for iPhone and iPad and it will be here.',
  },
  shopPage: {
    title: "This build of Restock can't open a shop's own page",
    why: "Opening the shop's website inside Restock, to sign in, pick your branch or pass the shop's \"are you a person\" check, needs a part of the app this build was made without.",
    instead: 'Install the newest Restock for iPhone and iPad and it will be here. Searching and price checks still work for shops that answer without it.',
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
export function NotHereBanner({ reason, title, preview }: { /** 0.15.0: none when it always works on an iPhone. */ reason?: IosReason; /** Off an iPhone: "Sync works in the Android app". */ title: string; preview?: ReactNode }) {
  if (isIos() && !reason) return null;
  if (!isIos() || !reason)
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
