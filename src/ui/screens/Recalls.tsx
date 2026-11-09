import { useState } from 'react';
import { getKV, getSettings, putKV, refresh, updateSettings } from '../../lib/db';
import { ensureNotificationPermission } from '../../lib/notify';
import { RestockNative } from '../../lib/sql/native';
import { useLive } from '../../lib/useLive';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { Icon, LoadingBar, timeAgo, TopBar } from '../components';
import { useNav } from '../nav';

// Recall alerts: once a day (separately from price checks, and not adjustable) Android checks the
// official Australian recall lists against what you have. RecallChecker.java does the checking,
// for both the daily check and "Check now", and saves what it found for this page.

export interface FoundRecall {
  id: string;
  source: string;
  title: string;
  url: string;
  date?: string;
  reason?: string;
  dates?: string;
  whatToDo?: string;
  affected: string[];
  foundAt: string;
}

export const OFFICIAL = [
  { name: 'Food recalls', who: 'Food Standards Australia New Zealand', url: 'https://www.foodstandards.gov.au/food-recalls/alerts' },
  { name: 'Product recalls', who: 'Product Safety Australia (ACCC)', url: 'https://www.productsafety.gov.au/recalls' },
  { name: 'Medicine recalls', who: 'Therapeutic Goods Administration', url: 'https://apps.tga.gov.au/PROD/SARA/arn-report.aspx' },
];

const SOURCE: Record<string, string> = { FSANZ: 'Food Standards Australia New Zealand', TGA: 'Therapeutic Goods Administration' };

/** 0.9.0: the official recall sites. A notice's link is only opened if it's https on one of these (or under one). Same as Recalls.java. */
const OFFICIAL_HOSTS = ['foodstandards.gov.au', 'productsafety.gov.au', 'tga.gov.au'];

/** The list a source's notices come from (Recalls.java listPage). */
function listPage(source: string): string {
  if (source === 'FSANZ') return 'https://www.foodstandards.gov.au/food-recalls/alerts';
  if (source === 'TGA') return 'https://www.tga.gov.au/safety/safety-alerts';
  return 'https://www.productsafety.gov.au/recalls';
}

/** The notice's own link if it's on an official recall site over https, else its list's page. */
export function recallLink(r: Pick<FoundRecall, 'url' | 'source'>): string {
  try {
    const u = new URL(String(r.url ?? '').trim());
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && !u.username && !u.password && OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return u.href;
  } catch {
    // Not a web address: the list instead.
  }
  return listPage(String(r.source ?? ''));
}

/** Possible recalls that haven't been marked "Not my product". */
export async function openRecalls(): Promise<FoundRecall[]> {
  const [all, dismissed] = await Promise.all([getKV<FoundRecall[]>('recalls'), getKV<string[]>('recallDismissed')]);
  const gone = new Set(dismissed ?? []);
  return (all ?? []).filter((r) => r && !gone.has(r.id)).sort((a, b) => (b.foundAt ?? '').localeCompare(a.foundAt ?? ''));
}

async function dismiss(id: string) {
  const d = (await getKV<string[]>('recallDismissed')) ?? [];
  await putKV('recallDismissed', [...new Set([...d, id])]);
}

/** The Recall alerts switch (Settings, setup tile and the Recalls page). */
export function RecallSettings({ settings, inSetup }: { settings: Settings; inSetup?: boolean }) {
  const on = settings.recalls.enabled;
  return (
    <div className="card flush">
      <label className="check">
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            Recall alerts
          </span>
          <span className="small">
            Once a day, Restock checks the official Australian recall lists (food, products and medicines) against what's in your Pantry, Keg,
            Pharmacy, shopping list and kept receipts.{inSetup ? ' On by default.' : ''}
          </span>
        </span>
        <input
          type="checkbox" className="switch"
          checked={on}
          aria-label="Recall alerts"
          onChange={async (e) => {
            const enabled = e.target.checked;
            if (enabled) await ensureNotificationPermission().catch(() => false);
            await updateSettings({ recalls: { ...settings.recalls, enabled } });
            if (isNative()) await RestockNative.scheduleRecalls({ enabled }).catch(() => undefined);
          }}
        />
      </label>
    </div>
  );
}

export function RecallCard({ r, onDismiss }: { r: FoundRecall; onDismiss?: () => void }) {
  return (
    <div className="card recall">
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span className="recall-mark" aria-hidden="true">
          <Icon name="alert" size={18} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="eyebrow" style={{ color: 'var(--red-ink)' }}>
            Possible recall
          </span>
          <strong style={{ display: 'block' }}>{r.title}</strong>
          <span className="small">
            {SOURCE[r.source] ?? r.source}
            {r.date ? ` · ${r.date}` : ''}
          </span>
        </span>
      </div>
      {r.affected?.length > 0 && (
        <p className="small" style={{ margin: 0 }}>
          <strong>Looks like:</strong> {r.affected.join(', ')}
        </p>
      )}
      {r.reason && (
        <p className="small" style={{ margin: 0 }}>
          <strong>Why:</strong> {r.reason}
        </p>
      )}
      {r.dates && (
        <p className="small" style={{ margin: 0 }}>
          <strong>Which ones:</strong> {r.dates}
        </p>
      )}
      {r.whatToDo && (
        <p className="small" style={{ margin: 0 }}>
          <strong>What to do:</strong> {r.whatToDo}
        </p>
      )}
      <p className="small" style={{ margin: 0 }}>
        Check the brand, size and dates on yours against the official notice. Restock matches by name, so it can be wrong.
      </p>
      <div className="two">
        <a className="btn small primary" href={recallLink(r)} style={{ textDecoration: 'none' }}>
          <Icon name="external" size={16} /> Official notice
        </a>
        {onDismiss && (
          <button className="btn small" onClick={onDismiss}>
            Not my product
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings → Recall alerts, and where a recall notification opens. */
export function RecallsScreen() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const found = useLive(openRecalls, []);
  const [busy, setBusy] = useState(false);
  if (!settings || !found) return <div className="screen" />;

  const check = async () => {
    setBusy(true);
    try {
      const r = await RestockNative.checkRecalls();
      refresh();
      const failed = Object.keys(r.errors);
      nav.toast(
        failed.length && !r.checked
          ? `Couldn't reach the recall lists: ${Object.values(r.errors)[0]}`
          : r.found
            ? `${r.found} possible recall${r.found === 1 ? '' : 's'} for things you have`
            : `Checked ${r.checked} recent recalls: nothing matches what you have`,
      );
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <TopBar title="Recall alerts" />
      <RecallSettings settings={settings} />
      <div className="card">
        <span className="small">
          Checked every 24 hours, on its own schedule (separate from price checks).{' '}
          {settings.recalls.lastCheck ? `Last checked ${timeAgo(settings.recalls.lastCheck)}.` : 'Not checked yet.'}
        </span>
        <button className="btn primary" disabled={busy || !isNative()} onClick={() => void check()}>
          <Icon name="refresh" size={17} /> {busy ? 'Checking…' : 'Check now'}
        </button>
        {busy && <LoadingBar seconds={20} />}
        {!isNative() && <p className="small">Checks run in the Android app.</p>}
      </div>

      <div className="eyebrow">Possible recalls</div>
      {found.length ? (
        found.map((r) => (
          <RecallCard
            key={r.id}
            r={r}
            onDismiss={async () => {
              await dismiss(r.id);
              nav.toast('Hidden. Restock won’t show that recall again.');
            }}
          />
        ))
      ) : (
        <p className="small">Nothing recalled that matches what you have.</p>
      )}

      <div className="eyebrow">The official lists</div>
      <div className="card flush">
        {OFFICIAL.map((o) => (
          <a key={o.url} className="row" href={o.url} style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                {o.name}
              </span>
              <span className="small">{o.who}</span>
            </span>
            <Icon name="external" size={17} />
          </a>
        ))}
      </div>
      <p className="small">
        Restock isn't an official alert service and can miss a recall or flag one that isn't yours. For anything you're worried about, check the
        official list, or ask the shop or a pharmacist.
      </p>
    </div>
  );
}

/** Home: a red card while a possible recall is open. */
export function RecallBanner() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const found = useLive(openRecalls, []);
  if (!settings?.recalls.enabled || !found?.length) return null;
  const first = found[0];
  return (
    <button className="card recall-banner" onClick={() => nav.push({ name: 'recalls' })}>
      <span className="recall-mark" aria-hidden="true">
        <Icon name="alert" size={20} />
      </span>
      <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <strong style={{ display: 'block' }}>
          {found.length === 1 ? 'Possible recall' : `${found.length} possible recalls`}
          {first.affected?.[0] ? `: ${first.affected[0]}` : ''}
        </strong>
        <span className="small clip" style={{ display: 'block' }}>
          {first.title}
        </span>
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );
}

/** For Settings: "On · checked 3 hours ago". */
export function recallSummary(s: Settings): string {
  if (!s.recalls.enabled) return 'Off';
  return s.recalls.lastCheck ? `On · checked ${timeAgo(s.recalls.lastCheck)}` : 'On · checked every day';
}
