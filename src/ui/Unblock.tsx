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

export type UnblockResult = 'working' | 'blocked' | 'unknown';

/** Open the shop's page, then check it once. */
export async function unblockShop(chain: StoreChain): Promise<UnblockResult> {
  await RestockNative.openStore({ chain, home: websiteOf(chain), message: UNBLOCK_BAR });
  // A search page worked out from a "checking your browser" page could be wrong: look again.
  if ((kindOf(chain) ?? 'web') === 'web') await forgetSearchInfo(chain).catch(() => undefined);
  if (isPressOnlyShop(chain)) return 'unknown';
  const settings = await getSettings();
  const [r] = await testConnections([chain], { [chain]: settings.stores[chain]?.storeId });
  if (!r) return 'unknown';
  if (r.ok) await unhideWarning(chain).catch(() => undefined);
  return r.ok ? 'working' : 'blocked';
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
        {name} isn’t letting Restock in. Its website is most likely checking for bots. That’s its check, not Restock’s. Pass it once yourself and prices carry on.
      </p>
      <ol className="unblock-steps">
        <li>The shop’s own page opens.</li>
        <li>Do its tick box or puzzle if it shows one.</li>
        <li>Wait until you see its normal page with products.</li>
        <li>Tap Done.</li>
      </ol>
      <p className="small" style={{ margin: 0 }}>
        Restock then reads {name} through that visit until the shop asks again. Nothing you type on the shop’s page goes to Restock.
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
          <Icon name="external" size={18} /> {stage === 'blocked' ? `Open ${name} again` : `Open ${name}`}
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
