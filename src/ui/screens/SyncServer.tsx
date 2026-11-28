// 0.15.0: the Restock server's parts of Sync and backups (moved out of Sync.tsx): adding a phone,
// a 0.9.3-style server, and leaving the server.
import { andList } from '../../lib/minVersion';
import { useEffect, useState } from 'react';
import { myRole, serverPhones } from '../../lib/serverPhones';
import { confirmAction } from '../../lib/confirm';

import { chainName, enabledIn, SECTION_NAMES } from '../../shops';
import type { Settings } from '../../types';
import { RestockNative, type TakeBack } from '../../lib/sql/native';
import { syncAvailable, type SyncInfo } from '../../lib/sync';
import { useSettings } from '../../lib/useLive';
import { LoadingBar, Sheet, More } from '../components';
import { useNav } from '../nav';
import { webLink } from '../../lib/site';
import { errText, plural, addressText } from './Sync';

/**
 * The Restock server: a card of its own, so a phone can use it alongside Phone sharing and the
 * away-from-home choice. Join with the code on the server's Add a phone page; once joined, scan the
 * web page's code to let a browser see the household (or sign in there).
 */
/**
 * A phone still connected to a 0.9.3-style server (v2). 0.15.0: servers don't keep such a household
 * any more, so this only says what to do and lets the phone stop using it.
 */
export function ServerCard({ info, busy, onInfo }: { info: SyncInfo; busy: boolean; onInfo: (i: SyncInfo) => void }) {
  const nav = useNav();
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState<string>();

  const stop = async () => {
    const photos = info.serverPhotos ?? 0;
    const ok = await confirmAction('Stop syncing through the Restock server?', {
      detail:
        (photos ? `${plural(photos, 'receipt photo')} kept on the server come back onto this phone first. ` : '') +
        "Older prices this phone moved there stay on the server. This phone comes off the server's list; Phone sharing and sync away from home carry on.",
      action: 'Stop',
    });
    if (!ok) return;
    setError(undefined);
    setWorking(photos ? 'Bringing the photos back…' : 'Stopping…');
    try {
      onInfo(await RestockNative.syncStopServer({ bringBack: true }));
      nav.toast('Stopped using the Restock server');
    } catch (e) {
      setWorking(undefined);
      const anyway = await confirmAction("Couldn't bring the photos back", {
        detail: `${errText(e)} If you stop anyway, those photos stay on the server and this phone can't show them.`,
        action: 'Stop anyway',
        danger: true,
      });
      if (anyway) {
        try {
          onInfo(await RestockNative.syncStopServer({ bringBack: false }));
          nav.toast('Stopped using the Restock server');
        } catch (e2) {
          setError(errText(e2));
        }
      }
    } finally {
      setWorking(undefined);
    }
  };

  return (
    <div className="card" style={{ gap: 8 }}>
      <span className="title" style={{ fontSize: 15 }}>
        Your server needs one step first
      </span>
      <span className="small">
        It still keeps your household the way Restock 0.9.3 did, which Restock 0.15.0 no longer does. Run Restock server 0.14.1 once and hand the household to it from the owner phone
        on Restock 0.14.1, then update both. Or stop using the server: your phones keep everything they have.
      </span>
      <span className="small">
        At home: {addressText(info.serverHome) || 'not set'}
        {info.serverAway ? ` · Away: ${addressText(info.serverAway)}` : ''}
      </span>
      <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={busy || !!working} onClick={() => void stop()}>
        Stop using this server
      </button>
      {working && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="small">{working}</span>
          <LoadingBar seconds={8} />
        </div>
      )}
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Add a phone: to the Restock server (on the server's page: the server decides who's in the house),
 * or, with no server, a code on this Wi-Fi only. Opens InviteSheet for the Wi-Fi way.
 */
export function AddPhoneSheet({ info, onClose, onWifi }: { info: SyncInfo; onClose: () => void; onWifi: () => void }) {
  const nav = useNav();
  const house = !!info.house || info.serverApi === 3;
  // Only the owner of a household without a server (or a phone not in one) shows a Wi-Fi code.
  const wifiOk = !house && (!info.paired || !!info.isOwner);
  const page = webLink(info.serverHome ?? info.serverRow?.home);
  return (
    <Sheet title="Add a phone" onClose={onClose}>
      {info.server || house ? (
        <div className="sync-choice recommended">
          <span className="eyebrow green" style={{ margin: 0 }}>
            To your Restock server
          </span>
          <strong style={{ fontSize: 17 }}>Add it on the server's page</strong>
          <span className="small">Your server decides who's in the house. Add a phone from the server's page.{' '}<More title="Adding a phone with a server"><p>Your server decides who's in the house. On a computer, open the server's page, choose <strong>Add a phone</strong>, name it (like
            "Sister's phone"), and scan the code with the new phone. Works anywhere, around the clock.</p></More></span>
          {page && (
            <a href={page} target="_blank" rel="noreferrer" style={{ minHeight: 40, display: 'flex', alignItems: 'center' }}>
              Open the server's page
            </a>
          )}
        </div>
      ) : (
        <button className="sync-choice" onClick={() => nav.push({ name: 'restockServer' })}>
          <strong style={{ fontSize: 17 }}>Use your Restock server</strong>
          <span className="small">Have a server at home? Join it first; then phones are added on its page, and sync at home and away.</span>
        </button>
      )}
      {wifiOk ? (
        <button className="sync-choice" disabled={!syncAvailable()} onClick={onWifi}>
          <strong style={{ fontSize: 17 }}>On this Wi-Fi only</strong>
          <span className="small">No server. Phones swap changes on this Wi-Fi. This phone shows a code for the other to scan.</span>
        </button>
      ) : (
        !house &&
        info.paired && (
          <p className="small" style={{ margin: 0 }}>
            On this Wi-Fi only: the owner phone{info.members?.find((m) => m.owner) ? ` (${info.members.find((m) => m.owner)!.name})` : ''} shows the
            code for a new phone.
          </p>
        )
      )}
      {house && (
        <p className="small" style={{ margin: 0 }}>Phone sharing is separate and off. Set it up on the Phone sharing screen.</p>
      )}
      <button className="btn block" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

/** The personal things a phone can take back off a v3 server (never groceries). */
const PERSONAL: { kind: TakeBack; title: string }[] = [
  { kind: 'keg', get title() { return SECTION_NAMES.keg; } },
  { kind: 'pharmacy', get title() { return SECTION_NAMES.pharmacy; } },
  { kind: 'receipts', title: 'Receipts' },
  { kind: 'cards', title: 'Loyalty cards' },
];

/** The personal things this phone shares with its server now. */
export function personalShared(info: SyncInfo | undefined): TakeBack[] {
  const tabs = info?.tabs ?? info?.myTabs ?? [];
  return PERSONAL.map((p) => p.kind).filter((k) => (k === 'receipts' ? !!info?.shareReceipts : k === 'cards' ? !!info?.shareCards : tabs.includes(k)));
}

/** The grocery shops this phone follows, by name ("Coles, Woolworths and Aldi"), or the general words. */
export function shopsText(s: Settings | undefined): string {
  const names = s ? [...new Set(enabledIn(s.enabledChains, 'pantry').map((c) => chainName(c)))] : [];
  if (!names.length || names.length > 6) return 'Coles, Woolworths, Aldi and the others';
  return andList(names);
}

/** Always said when a phone stops sharing something or leaves: shop data isn't personal, and it stays. */
export function ShopDataStays() {
  const settings = useSettings();
  return (
    <span className="small"><strong style={{ color: 'var(--ink)' }}>Prices and product details</strong> your phone found at your shops ({shopsText(settings)}) stay on the server
      for the household, with the shared shopping list and pantry. They're about the shops, not about you.</span>
  );
}

/** What a take-back tick removes, in words (TurnOffSheet and the Leave sheet). */
export const TAKE_BACK_NOTE =
  "Only what this phone added comes off the server and the house's other phones. Other people's things stay, and this phone keeps its own copy.";

/**
 * Leaves the server (0.9.4): the ticked personal kinds this phone shares come off the server first
 * (only what it added), as turning each off with its box ticked; groceries never. Rejects (and the
 * phone stays) if they can't be taken back or its photos can't come back.
 */
export function leaveServer(info: SyncInfo, ticked: TakeBack[], bringBack = true): Promise<SyncInfo> {
  const offered = info.house || info.serverApi === 3 ? [...personalShared(info), ...(info.takeBack ?? [])] : [];
  return RestockNative.syncStopServer({ bringBack, takeBack: ticked.filter((k) => offered.includes(k)) });
}

export function LeaveServerSheet({ info, onClose, onDone }: { info: SyncInfo; onClose: () => void; onDone: (i: SyncInfo) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const label = info.serverLabel?.trim() || 'the server';
  // 0.9.4: the receipt photos this phone moved to the server come back first; if they can't (out of
  // reach), it doesn't leave, and the person can try again or leave them there.
  const [photosStuck, setPhotosStuck] = useState(false);
  // 0.9.4: the personal things it shares, each with an unticked "take it back" box (as turning it off).
  // Review fix: a kind ticked here stays offered (and ticked) after a try that couldn't reach the
  // server, which already turned it off and is taking it back (info.takeBack), so trying again
  // still takes it back first.
  const [back, setBack] = useState<TakeBack[]>([]);
  const shared = info.house || info.serverApi === 3 ? personalShared(info) : [];
  const personal = [...shared, ...back.filter((k) => !shared.includes(k) && (info.takeBack ?? []).includes(k))];
  const allTicked = personal.length > 0 && personal.every((k) => back.includes(k));
  const flip = (k: TakeBack, on: boolean) => setBack((b) => (on ? [...new Set([...b, k])] : b.filter((x) => x !== k)));
  // 0.18.1: the server's only admin phone is told what leaving means for looking after the phones.
  const [onlyAdmin, setOnlyAdmin] = useState(false);
  useEffect(() => {
    if (info.serverApi !== 3) return;
    let live = true;
    void myRole()
      .then((r) => (r === 'admin' ? serverPhones() : undefined))
      .then((list) => {
        if (!live || !list) return;
        const admins = list.filter((p) => (!p.status || p.status === 'active') && p.role === 'admin');
        setOnlyAdmin(admins.length === 1 && !!admins[0].me);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [info.serverApi]);
  const leave = async (bringBack = true, takeBack: TakeBack[] = back) => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await leaveServer(info, takeBack, bringBack));
    } catch (e) {
      const m = errText(e);
      setError(m);
      setPhotosStuck(/receipt photos back/i.test(m));
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Leave ${label}?`} onClose={busy ? () => undefined : onClose}>
      <p className="small" style={{ margin: 0, fontSize: 15 }}>
        This phone stops syncing with the server and keeps everything it has now.
      </p>
      {onlyAdmin && (
        <div className="banner amber" role="alert">
          <strong>This is the server&rsquo;s only admin phone.</strong> Once it leaves, phones can only be added, removed or made admins on the server&rsquo;s web page, with
          the passphrase. To keep an admin phone, make another one an admin first (Phones and tablets).
        </div>
      )}
      <div className="card" style={{ gap: 8 }}>
        <ShopDataStays />
        <span className="small">
          {personal.length ? (
            <>
              <strong style={{ color: 'var(--ink)' }}>Your personal things stay too, unless you tick them below</strong>: what this phone shared of{' '}
              {andList(PERSONAL.filter((p) => personal.includes(p.kind)).map((p) => (p.kind === 'cards' ? 'loyalty cards' : p.kind === 'receipts' ? 'receipts' : p.title)))}.
            </>
          ) : info.house || info.serverApi === 3 ? (
            "This phone didn't share anything personal (Bottle shop, Chemist, receipts or loyalty cards)."
          ) : (
            <>
              <strong style={{ color: 'var(--ink)' }}>On the server, nothing is deleted.</strong> What this phone shared stays there for the house: prices,
              history, receipts.
            </>
          )}
        </span>
        <span className="small">
          The server's page shows this phone as <strong style={{ color: 'var(--ink)' }}>Left</strong>. To come back, scan a new code from the server's
          page.
        </span>
        <span className="small">Ending the whole house, or removing someone else's phone, is done on the server's page.</span>
      </div>
      {personal.length > 0 && (
        <div className="card flush">
          <div className="section-head">
            <span className="title">Also take these off the server</span>
            <button className="linkish small" type="button" disabled={busy} onClick={() => setBack(allTicked ? [] : personal)}>
              {allTicked ? 'Select none' : 'Select all'}
            </button>
          </div>
          {PERSONAL.filter((p) => personal.includes(p.kind)).map((p) => (
            <label key={p.kind} className="check">
              <input type="checkbox" checked={back.includes(p.kind)} disabled={busy} onChange={(e) => flip(p.kind, e.target.checked)} />
              <span className="title" style={{ fontSize: 15, flex: 1 }}>
                {p.title}
              </span>
            </label>
          ))}
          <p className="small" style={{ margin: 0, padding: '0 16px 12px' }}>
            {TAKE_BACK_NOTE}
          </p>
        </div>
      )}
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
      <button className="btn block danger" disabled={busy} onClick={() => void leave()}>
        {busy ? 'Leaving…' : back.some((k) => personal.includes(k)) ? `Take those back and leave ${label}` : `Leave ${label}`}
      </button>
      {photosStuck && !busy && (
        <button className="btn block" onClick={() => void leave(false)}>
          Leave without the photos (they stay on the server)
        </button>
      )}
      {/Couldn't take those things off the server/i.test(error ?? '') && !busy && (
        <button className="btn block" onClick={() => void leave(true, [])}>
          Leave without taking them back (they stay on the server)
        </button>
      )}
      {busy && <LoadingBar seconds={6} />}
      <button className="btn block" disabled={busy} onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}
