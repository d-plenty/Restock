import { useState } from 'react';
import { RestockNative } from '../lib/sql/native';
import { getSettings } from '../lib/db';
import { hideWarning, testConnections, unhideWarning, type StoreChain } from '../lib/health';
import { isNative } from '../stores/http';
import { forgetSearchInfo } from '../stores/web';
import { chainName, isPressOnlyShop, kindOf, websiteOf } from '../shops';
import { Icon, Sheet } from './components';
import { useNav } from './nav';

// 0.10.4: "Unblock <shop>". When a shop's website turns Restock away (it answers 403, or shows a
// "checking your browser" page), the person passes the shop's own check in Restock's built-in
// browser: the same browser Restock reads the shop with, so the visit's cookies carry on. Restock
// never solves, skips or hides from a check by itself. Works for every shop, built in or added by
// the person (openStore takes the shop's website as `home`).

/** What the shop's page says along the top while it's open (StoreWeb.java's bar). */
export const UNBLOCK_BAR = 'Do the tick box or puzzle if the page shows one. When you see its normal page with products, tap Done.';

// 0.12.8: 'unread': the shop's page opened and nothing turned Restock away, but no products could be
// read from its search (it said "Still blocked" for that too, which sent people round in circles).
export type UnblockResult = 'working' | 'blocked' | 'unread' | 'unknown';

/** What a test of one shop came to (pure, for testing). */
export function resultOf(r: { ok: boolean; blocked?: boolean } | undefined): UnblockResult {
  if (!r) return 'unknown';
  return r.ok ? 'working' : r.blocked ? 'blocked' : 'unread';
}

/** Test one shop now, as Test connections does. */
export async function testShop(chain: StoreChain): Promise<{ result: UnblockResult; error?: string }> {
  if (isPressOnlyShop(chain)) return { result: 'unknown' };
  const settings = await getSettings();
  const [r] = await testConnections([chain], { [chain]: settings.stores[chain]?.storeId });
  if (r?.ok) await unhideWarning(chain).catch(() => undefined);
  return { result: resultOf(r), error: r?.error };
}

/** Open the shop's page, then check it once. */
export async function unblockShop(chain: StoreChain): Promise<UnblockResult> {
  await RestockNative.openStore({ chain, home: websiteOf(chain), message: UNBLOCK_BAR });
  // A search page worked out from a "checking your browser" page could be wrong: look again.
  if ((kindOf(chain) ?? 'web') === 'web') await forgetSearchInfo(chain).catch(() => undefined);
  return (await testShop(chain)).result;
}

/** What "Try again" says when the shop still isn't working (pure, for testing). */
export function tryAgainWords(name: string, result: UnblockResult): string {
  if (result === 'working') return `${name} is working again.`;
  if (result === 'blocked') return `${name} is still blocking Restock. Tap Unblock ${name} and pass its check.`;
  if (result === 'unread') return `${name} answered, but Restock couldn't read any products from it. Try Unblock ${name}, or again later.`;
  return `Restock tries ${name} again the next time you search it.`;
}

/**
 * 0.12.8: "Try again" on a shop's warning. It tests that one shop and says what happened (it ran the
 * whole price check, whose progress is at the top of Home: scrolled down, it looked like nothing).
 */
export function TryAgain({ chain, onWorked }: { chain: StoreChain; onWorked?: () => void }) {
  const nav = useNav();
  const name = chainName(chain);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  const go = async () => {
    if (busy) return;
    if (!isNative() || isPressOnlyShop(chain)) return onWorked?.();
    setBusy(true);
    setSaid(undefined);
    const { result } = await testShop(chain).catch(() => ({ result: 'unread' as UnblockResult }));
    setBusy(false);
    if (result === 'working') {
      nav.toast(tryAgainWords(name, result));
      onWorked?.();
    } else setSaid(tryAgainWords(name, result));
  };
  return (
    <>
      <button className={`btn small${busy ? ' is-busy' : ''}`} style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void go()}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={16} />} {busy ? `Checking ${name}…` : 'Try again'}
      </button>
      {/* Said under the button, where the tap was (and read out) */}
      <span className="small try-again-said" role="status">
        {busy ? 'This can take up to a minute.' : (said ?? '')}
      </span>
    </>
  );
}

/** The steps, then the shop's page, then whether it worked. */
export function UnblockSheet({ chain, onClose, onWorked }: { chain: StoreChain; onClose: () => void; onWorked?: () => void }) {
  const name = chainName(chain);
  const [stage, setStage] = useState<'steps' | 'checking' | UnblockResult>('steps');
  const go = async () => {
    setStage('checking');
    const r = await unblockShop(chain).catch(() => 'blocked' as const);
    setStage(r);
    if (r === 'working') onWorked?.();
  };
  return (
    <Sheet title={`Unblock ${name}`} onClose={onClose}>
      <p style={{ margin: 0 }}>
        {name}’s website wants to check you’re a person. Pass its check once and prices carry on. It’s {name}’s own check: nothing’s wrong
        with Restock or your phone.
      </p>
      <ol className="unblock-steps">
        <li>The shop’s own page opens.</li>
        <li>Do its tick box or puzzle if it shows one.</li>
        <li>Wait until you see its normal page with products.</li>
        <li>Tap Done.</li>
      </ol>
      <p className="small" style={{ margin: 0 }}>
        If a shop changes its website or blocks Restock, its prices stop until that’s sorted. That’s on the shop’s side, not something you did.
        Nothing you type on the shop’s page goes to Restock.
      </p>
      {stage === 'checking' && (
        <div className="banner grey" role="status">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spinner" aria-hidden="true" /> Checking {name}…
          </span>
        </div>
      )}
      {stage === 'working' && (
        <div className="banner green" role="status">
          <strong>{name} is working again</strong>
          <span style={{ fontSize: 13 }}>Prices carry on at the next check.</span>
        </div>
      )}
      {stage === 'unread' && (
        <div className="banner amber" role="status">
          <strong>{name} opened, but Restock still can’t read it</strong>
          <span style={{ fontSize: 13 }}>
            Nothing is blocking it now, but no products came back. If its page asks you to choose a shop near you, choose one and wait for products
            before you tap Done. If it still won’t work, {name}’s website may have changed: Settings, Feedback tells the developer.
          </span>
        </div>
      )}
      {stage === 'blocked' && (
        <div className="banner amber" role="status">
          <strong>Still blocked: try again later</strong>
          <span style={{ fontSize: 13 }}>
            {name} still isn’t answering. Wait until its page shows products before you tap Done, or try again in an hour or so.
          </span>
        </div>
      )}
      {stage === 'unknown' && (
        <div className="banner green" role="status">
          <strong>Done</strong>
          <span style={{ fontSize: 13 }}>Restock tries {name} again the next time you search it.</span>
        </div>
      )}
      {stage === 'working' || stage === 'unknown' ? (
        <button className="btn primary block" onClick={onClose}>
          Done
        </button>
      ) : (
        <button className="btn primary block" disabled={!isNative() || stage === 'checking'} onClick={() => void go()}>
          <Icon name="external" size={18} /> {stage === 'blocked' || stage === 'unread' ? `Open ${name} again` : `Open ${name}`}
        </button>
      )}
      {!isNative() && (
        <p className="small" style={{ margin: 0 }}>
          Only in the Android app: the shop’s page opens on your phone.
        </p>
      )}
    </Sheet>
  );
}

/** The big green "Unblock <shop>" button. On the web it's greyed, saying where it works. */
export function UnblockButton({ chain, onWorked, small, label }: { chain: StoreChain; onWorked?: () => void; small?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={`btn primary ${small ? 'small' : 'block'}`}
        disabled={!isNative()}
        title={isNative() ? undefined : 'Only in the Android app'}
        onClick={() => setOpen(true)}
      >
        <Icon name="unlock" size={small ? 16 : 18} /> {label ?? `Unblock ${chainName(chain)}`}
      </button>
      {open && <UnblockSheet chain={chain} onClose={() => setOpen(false)} onWorked={onWorked} />}
    </>
  );
}

/** The small grey "Hide for a day" link. Not recommended: the warning is back in 24 hours if the shop's still failing. */
export function HideForADay({ chain }: { chain: StoreChain }) {
  const nav = useNav();
  return (
    <button
      type="button"
      className="link-quiet"
      onClick={() => void hideWarning(chain).then(() => nav.toast(`Hidden for a day. It's back tomorrow if ${chainName(chain)} still isn't working.`))}
    >
      Hide for a day
    </button>
  );
}
