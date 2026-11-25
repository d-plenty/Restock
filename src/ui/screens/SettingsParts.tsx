// 0.15.0: Settings' larger parts (moved out of Settings.tsx): connections, price checks,
// notifications, and app updates.
import { IOS_CHECK_EVERY_HOURS } from '../../lib/check';
import { isIos } from '../../lib/platform';
import { useEffect, useState, type ReactNode } from 'react';
import { version } from '../../../package.json';
import { getSettings as savedSettings, updateSettings as saveNow } from '../../lib/db';
import { afterSave, updateSettings } from '../../lib/settingsDraft';
import { syncBackgroundSchedule } from '../../lib/check';
import { CHECK_TIME_0110, checkChoice, type CheckChoice, dayWords, isCheckTime, presetDays, timeWords } from '../../lib/checkSchedule';
import { ensureNotificationPermission, scheduleReminders } from '../../lib/notify';
import { useLive } from '../../lib/useLive';
import { chainName, WEEKDAYS, type Settings } from '../../types';
import { ChainDot, Icon, Sheet, timeAgo, More } from '../components';
import { UnblockButton } from '../Unblock';
import { getHealth, testConnections, type ConnectionTest, type StoreChain } from '../../lib/health';
import { useNav } from '../nav';
import { checkForUpdate, installUpdate, RELEASES, SELF_UPDATE, type UpdateInfo } from '../../lib/updates';
import { webLink } from '../../lib/site';
import { GROUP_LABEL, shopGroups } from './Settings';

export function ConnectionsSheet({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const groups = shopGroups(settings);
  const chains: StoreChain[] = groups.flatMap((g) => g.chains);
  const [results, setResults] = useState<ConnectionTest[]>();
  const health = useLive(getHealth, []);
  const [running, setRunning] = useState(false);
  const run = async () => {
    // 0.10.5: each shop's result shows as soon as it's in.
    setResults([]);
    setRunning(true);
    await testConnections(
      chains,
      Object.fromEntries(chains.map((c) => [c, settings.stores[c]?.storeId])),
      (r) => setResults((cur) => [...(cur ?? []).filter((x) => x.chain !== r.chain), r]),
    ).finally(() => setRunning(false));
  };
  useEffect(() => {
    void run();
    // Checks the shops once, when this opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Sheet title="Test connections" onClose={onClose}>
      <p className="small">Restock searches each shop for a test word.{' '}<More title="Test connections"><p>Restock searches each shop the same way it does when you add an item: supermarkets for "milk", bottle shops for "beer" and chemists for
        "paracetamol".</p></More></p>
      {groups.map(({ section, chains: list }) => (
        <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name={section} size={15} /> {GROUP_LABEL[section]}
          </div>
          <div className="card flush">
            {list.map((c) => {
              const r = results?.find((x) => x.chain === c);
              const h = health?.[c];
              return (
                <div key={c} className="row" style={{ alignItems: 'flex-start' }}>
                  <span style={{ width: 24, paddingTop: 2 }}>
                    {!r ? (
                      <span className="spinner" aria-label="Testing" />
                    ) : r.ok ? (
                      <Icon name="check" size={20} />
                    ) : (
                      <Icon name="close" size={20} />
                    )}
                  </span>
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ChainDot chain={c} /> {chainName(c)}
                    </span>
                    <span className="small">
                      {!r
                        ? 'Testing…'
                        : r.ok
                          ? `Working: ${r.count} products in ${(r.ms / 1000).toFixed(1)} s`
                          : r.blocked
                            ? "Blocked: its website is checking for bots. That's its check, not Restock's."
                            : `Not working: ${r.error}${r.unblock ? '. Its website may be checking for bots: try Unblock.' : ''}`}
                    </span>
                    {h?.lastOk && <span className="small">Last worked {timeAgo(h.lastOk)}</span>}
                    {r && (r.blocked || r.unblock) && <UnblockButton chain={c} small onWorked={run} />}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {!chains.length && <p className="small">No shops picked yet. Choose them in Settings → My shops.</p>}
      <button className="btn" disabled={running} onClick={run}>
        <Icon name="refresh" size={18} /> Test again
      </button>
      <p className="small">Still failing? Try Unblock, or report it on GitHub.{' '}<More title="If a shop keeps failing"><p>Still failing? Try Shop connections → Always use the browser, or Unblock the shop and do its check if it asks. If a shop keeps
        failing, please{' '}
        <a href="https://github.com/d-plenty/Restock/issues/new/choose" target="_blank" rel="noreferrer">
          report it on GitHub
        </a>{' '}
        with the error above.</p></More></p>
    </Sheet>
  );
}

/**
 * Automatic price checks (Settings, and the setup tile). 0.11.0: five choices, on set days at one
 * time: every day, twice a week (Wednesday and Saturday, the default), once a week (Wednesday),
 * custom days and time, or off. The presets run at 4:00 am. Only what's in use is checked: the
 * products on your pantry items and shopping lists.
 */
const CHECK_CHOICES: { id: CheckChoice; label: string }[] = [
  // short, so the whole choice shows on a small phone; the line under it says the days and time
  { id: 'daily', label: 'Every day' },
  { id: 'twice', label: 'Twice a week (recommended)' },
  { id: 'weekly', label: 'Once a week' },
  { id: 'custom', label: 'Custom days and time' },
  { id: 'off', label: 'Off (Check now only)' },
];

export function PriceCheckSettings({ settings }: { settings: Settings }) {
  const days = settings.checkDays ?? [3, 6];
  const choice = checkChoice(days, settings.checkTime, settings.checkCustom);
  const save = async (patch: Partial<Pick<Settings, 'checkDays' | 'checkTime' | 'checkCustom'>> & { on?: boolean }) => {
    const { on, ...rest } = patch;
    const s = await updateSettings({ ...rest, ...(on !== undefined ? { sync: { ...settings.sync, backgroundActivity: on } } : {}) });
    // 0.9.5 (save): on a settings screen, once it's saved.
    await afterSave('checks', (saved) => syncBackgroundSchedule(saved).catch(() => undefined), s);
  };
  const pick = (c: CheckChoice) => {
    if (c === 'custom') {
      // starts from what's set now (from Wednesday and Saturday when checks were off)
      return save({ checkCustom: true, checkDays: days.length ? days : [3, 6], checkTime: settings.checkTime ?? CHECK_TIME_0110, on: true });
    }
    // every preset is at 4:00 am; picking one (other than Off) also turns background activity on
    return save({ checkCustom: false, checkDays: presetDays(c), checkTime: CHECK_TIME_0110, ...(c !== 'off' ? { on: true } : {}) });
  };
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b);
    // the last day can't be unticked here: Off is its own choice
    if (next.length) void save({ checkCustom: true, checkDays: next });
  };
  const blocked = choice !== 'off' && !settings.sync.backgroundActivity;

  // iPhone app: an iPhone can't run a check at a set time, so this is one switch: check when Restock is
  // opened (when the last check is more than 12 hours old), or only when Check now is tapped.
  if (isIos()) {
    const on = choice !== 'off' && settings.sync.backgroundActivity;
    return (
      <>
        <div className="card flush">
          <label className="check">
            <input className="switch" type="checkbox" checked={on} onChange={(e) => void pick(e.target.checked ? 'twice' : 'off')} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Check prices when I open Restock
              </span>
              <span className="small">Checks when you open Restock, at most every {IOS_CHECK_EVERY_HOURS} hours.{' '}<More title="Check prices when I open Restock"><p>Only the items in your pantry and your tabs. A check runs when you open Restock and the last one is more than {IOS_CHECK_EVERY_HOURS} hours old.</p></More></span>
            </span>
          </label>
          <div className="check" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <span className="small" role="status">
              {on
                ? 'An iPhone decides when apps may work in the background, so Restock can’t pick a time of day here. Open it now and then and your prices stay current. Check now on Home checks straight away.'
                : 'Nothing is checked until you tap Check now on Home. We recommend leaving this on: without it, prices and your specials at each shop go out of date.'}
            </span>
            <span className="small">Picking a time of day: not possible on iPhone due to Apple's restrictions.</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="card flush">
        <div className="check" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <label htmlFor="check-how-often" style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Check prices automatically
            </span>
            <span className="small">
              Only the items in your pantry and on your shopping lists. Only on a network connection and when the battery isn't low.
            </span>
          </label>
          <select id="check-how-often" className="input" style={{ height: 48, flex: 'none', width: '100%', fontSize: 15 }} value={choice} onChange={(e) => void pick(e.target.value as CheckChoice)}>
            {CHECK_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="small" role="status">
            {choice === 'off'
              ? 'Nothing is checked until you tap Check now on Home. We recommend leaving automatic checks on: without them, prices and your specials at each shop go out of date.'
              : `Runs ${dayWords(days)} at ${timeWords(settings.checkTime ?? CHECK_TIME_0110)}, your phone's own time. Android may run it a few minutes late; if the phone is off then, it checks soon after it's back. Checking by hand doesn't change it.`}
          </span>
        </div>
        {choice === 'custom' && (
          <>
            <div className="check" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <span className="title" style={{ fontSize: 15 }} id="check-days-label">
                Which days
              </span>
              <div className="day-picks" role="group" aria-labelledby="check-days-label">
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`chip${days.includes(d) ? ' on' : ''}`}
                    aria-pressed={days.includes(d)}
                    aria-label={WEEKDAYS[d]}
                    disabled={days.length === 1 && days.includes(d)}
                    onClick={() => toggleDay(d)}
                  >
                    {WEEKDAYS[d].slice(0, 3)}
                  </button>
                ))}
              </div>
              <span className="small">Wednesday is when new specials start. To check on no days, choose Off.</span>
            </div>
            <label className="check">
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 15 }}>
                  What time
                </span>
                <span className="small">One time, on each of those days.</span>
              </span>
              <input
                type="time"
                className="input"
                style={{ width: 'auto' }}
                value={settings.checkTime ?? CHECK_TIME_0110}
                onChange={(e) => {
                  if (isCheckTime(e.target.value)) void save({ checkCustom: true, checkTime: e.target.value });
                }}
                aria-label="Price check time"
              />
            </label>
          </>
        )}
        {blocked && (
          <div className="check" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} role="note">
            <span className="small">
              <strong>Background activity is off</strong> (Settings → Sync and backups), so these checks can't run by themselves.
            </span>
            <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void save({ on: true })}>
              Turn it on
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** Which alerts Restock sends (Settings, and the setup tile, 0.8.0). */
export function NotificationSettings({ settings }: { settings: Settings }) {
  const setAlerts = async (patch: Partial<Settings['alerts']>) => {
    // Turning an alert on is the moment to ask for notifications.
    if (Object.values(patch).some((v) => v === true)) await ensureNotificationPermission().catch(() => false);
    const s = await updateSettings({ alerts: { ...settings.alerts, ...patch } });
    // 0.9.5 (save): on a settings screen, once it's saved.
    await afterSave('reminders', (saved) => scheduleReminders(saved).catch(() => undefined), s);
  };

  return (
    <>
      <div className="card flush">
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.alerts.catalogueDay} onChange={(e) => setAlerts({ catalogueDay: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Weekly deals summary
            </span>
            <span className="small">Your items on special and what you'd save, each week.{' '}<More title="Weekly deals summary"><p>Which of your items are on special and roughly what you'd save, after the first price check that day. Wednesday is when new specials
              start.</p></More></span>
          </span>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={settings.alerts.catalogueWeekday}
            onChange={(e) => setAlerts({ catalogueWeekday: parseInt(e.target.value, 10) })}
            aria-label="Roundup day"
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d.slice(0, 3)}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.alerts.daily} onChange={(e) => setAlerts({ daily: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Daily reminder
            </span>
            <span className="small">A nudge to open the app and check prices.</span>
          </span>
          <input
            type="time"
            className="input"
            style={{ width: 'auto' }}
            value={settings.alerts.dailyTime}
            onChange={(e) => setAlerts({ dailyTime: e.target.value || '07:30' })}
            aria-label="Reminder time"
          />
        </label>
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.alerts.greatDeals} onChange={(e) => setAlerts({ greatDeals: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Great deals, straight away
            </span>
            <span className="small">When a price check finds a deal that matches an item's alert setting, or an item is under its target price.</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.alerts.stockUpTips} onChange={(e) => setAlerts({ stockUpTips: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Stock-up tips
            </span>
            <span className="small">On deals for things that only go on special every few weeks: "a good time to stock up".</span>
          </span>
        </label>
      </div>
    </>
  );
}

/** A settings card that folds away until you open it (0.7.3), so the page isn't a wall of options. */
export function Fold({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <details className="card flush fold">
      <summary className="row">
        <span className="grow">
          <span className="title">{title}</span>
          {sub && <span className="small">{sub}</span>}
        </span>
        <Icon name="chevron" size={18} />
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/**
 * Updates from GitHub (0.7.3): check now, install a newer release (Android shows its own Install
 * screen), and an optional weekly check when Restock opens. Nothing is sent but the request itself.
 */
export function UpdateRows({ settings }: { settings: Settings }) {
  // iPhone app: on an iPhone the section stays, greyed, and says why (Apple doesn't let an app update itself).
  if (isIos())
    return (
      <div className="card" aria-disabled="true">
        <span className="title">Updates</span>
        <span className="small">
          Restock {version}. Updating from inside the app: not possible on iPhone due to Apple's restrictions. New versions come from where you
          installed Restock.
        </span>
      </div>
    );
  if (!SELF_UPDATE) return null;
  return <UpdateRowsOn settings={settings} />;
}

function UpdateRowsOn({ settings }: { settings: Settings }) {
  const nav = useNav();
  const [busy, setBusy] = useState<'check' | 'install'>();
  const [found, setFound] = useState<UpdateInfo>();
  const [error, setError] = useState<string>();
  const [notes, setNotes] = useState(false);
  const u = settings.updates;
  const check = async () => {
    setBusy('check');
    setError(undefined);
    try {
      const info = await checkForUpdate(version);
      setFound(info);
      // 0.9.5 (save): when it last looked isn't a setting: kept at once.
      const was = (await savedSettings()).updates;
      // 0.10.12: and the newer version it found, so Home's Update available card shows it.
      await saveNow({ updates: { notify: !!was?.notify, ...was, lastCheck: new Date().toISOString(), ...(info.newer ? { told: info.version } : {}) } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const install = async () => {
    if (!found?.apkUrl) return;
    setBusy('install');
    setError(undefined);
    try {
      const r = await installUpdate(found.apkUrl);
      if (r === 'permission') nav.toast('Allow Restock to install apps, then come back and tap Update again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <span className="grow" style={{ minWidth: 180 }}>
          <span className="title">Check for updates</span>
          <span className="small">
            {found
              ? found.newer
                ? `Restock ${found.version} is ready. You have ${version}.`
                : `You have the latest version (${version}).`
              : `You have ${version}. New versions come from GitHub.`}
          </span>
        </span>
        {found?.newer && found.apkUrl ? (
          <button className="btn primary small" disabled={!!busy} onClick={() => void install()}>
            {busy === 'install' ? 'Downloading…' : 'Update'}
          </button>
        ) : (
          <button className="btn small" disabled={!!busy} onClick={() => void check()}>
            {busy === 'check' ? 'Checking…' : 'Check'}
          </button>
        )}
      </div>
      {found?.newer && (
        <div style={{ padding: '0 14px 12px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {found.notes && (
            <button className="linkish small" style={{ padding: 0 }} onClick={() => setNotes(true)}>
              What's new in {found.version}
            </button>
          )}
          <a className="small" href={webLink(found.pageUrl) ?? RELEASES} target="_blank" rel="noreferrer">
            Open the release on GitHub
          </a>
        </div>
      )}
      {error && (
        <div className="banner amber" style={{ margin: '0 14px 12px', fontSize: 13 }}>
          {error} You can also download it from <a href={RELEASES}>GitHub Releases</a>.
        </div>
      )}
      <label className="check">
        <input type="checkbox" className="switch" checked={!!u?.notify} onChange={(e) => void updateSettings({ updates: { ...u, notify: e.target.checked } })} />
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            Tell me when there's an update
          </span>
          <span className="small">When you open Restock, it asks GitHub if there's a newer version, at most this often.</span>
        </span>
      </label>
      {u?.notify && (
        <label className="check">
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              How often
            </span>
          </span>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={u.everyDays === 7 ? 7 : 1}
            aria-label="How often to check for updates"
            onChange={(e) => void updateSettings({ updates: { ...u, everyDays: e.target.value === '1' ? 1 : 7 } })}
          >
            <option value={1}>Every 24 hours (default)</option>
            <option value={7}>Every 7 days</option>
          </select>
        </label>
      )}
      {notes && found && (
        <Sheet title={`What's new in ${found.version}`} onClose={() => setNotes(false)}>
          <div className="small release-notes">{found.notes}</div>
        </Sheet>
      )}
    </>
  );
}
