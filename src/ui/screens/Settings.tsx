import { useEffect, useRef, useState, type ReactNode } from 'react';
import { version } from '../../../package.json';
import legal from '../../lib/legal.json';
import { confirmAction } from '../../lib/confirm';
import type { BackupSummary } from '../../lib/backup';
import { shareCsv } from '../../lib/csvExport';
import { RestockNative } from '../../lib/sql/native';
import { syncInfo, type SyncInfo } from '../../lib/sync';
import { isNative } from '../../stores/http';
import { allCards, allGiftCards, eraseEverything, getSettings as savedSettings, priceHistorySpan, pruneHistory, serverKeepsHistory, updateSettings as saveNow } from '../../lib/db';
// 0.9.5 (save): settings changed here wait for "Save settings" (settingsDraft.ts).
import { afterSave, getSettings, updateSettings } from '../../lib/settingsDraft';
import { dailyTimes, DEFAULT_CHECK_TIME, isCheckTime } from '../../lib/checkSchedule';
import { SaveBar, useSettingsDraft } from '../SaveBar';
import { loadDemo, removeDemo } from '../../lib/demo';
import { syncBackgroundSchedule } from '../../lib/check';
import { ensureNotificationPermission, scheduleReminders } from '../../lib/notify';
import { useLive } from '../../lib/useLive';
import { money } from '../../lib/units';
import { STALE_DAYS } from '../../lib/verdict';
import { chainName, CHECK_INTERVALS, GOOD_SALE, GREAT_SALE, HISTORY_WEEKS, historyLabel, WEEKDAYS, type Settings } from '../../types';
import { ChainDot, Explain, Icon, Logo, OpenStoreButton, Sheet, timeAgo, TopBar } from '../components';
import { AccessibilitySettings, LookSettings } from './Look';
import { AutoBackupSettings } from './Backups';
import { SyncOverview } from './SyncOverview';
import { ReceiptsSettings } from './Receipts';
import { recallSummary } from './Recalls';
import { ComingSoon } from './Soon';
import { WidgetSettings } from './WidgetSettings';
import { TILES, tileStatus } from './Setup';
import { startTour } from '../Tour';
import { downloadMarket, MARKET_SIZE_TEXT, MARKET_SOURCE, marketInfo, megabytes, removeMarket } from '../../lib/market';
import { getHealth, testConnections, type ConnectionTest, type StoreChain } from '../../lib/health';
import { useNav } from '../nav';
import { checkForUpdate, installUpdate, RELEASES, SELF_UPDATE, type UpdateInfo } from '../../lib/updates';
import { activeSections, searchChainsIn, type Section } from '../../shops';
import { shopSummary } from './Stores';
import { ExportSheet, pricesIn } from './BackupParts';
import { LegalSheet } from './Legal';
import { readBackupFile, RestoreSheet } from './Restore';
import { getHaConfig, haPhone, phoneLabel } from '../../lib/homeAssistant';
import { serverMode } from '../../server-mode/flag';

/** Settings → Shopping list: how much shopping around has to save (0.9.0). */
const SHOP_AROUND_MINS = [0, 0.5, 1, 2, 5, 10];

const intervalLabel = (h: number) => (h === 24 ? 'Once a day' : h === 48 ? 'Every 2 days' : h === 168 ? 'Once a week' : `Every ${h} hours`);

/**
 * Search: shows only the settings whose words match, by hiding the rest of the page (a heading
 * that matches shows its whole section). Returns how many settings matched.
 */
function filterSettings(root: HTMLElement, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (el: Element) => {
    const t = (el.textContent ?? '').toLowerCase() + ' ' + ((el as HTMLElement).getAttribute?.('aria-label') ?? '').toLowerCase();
    return words.every((w) => t.includes(w));
  };
  const all = [...root.children] as HTMLElement[];
  for (const el of root.querySelectorAll<HTMLElement>('[data-hide]')) delete el.dataset.hide;
  if (!words.length) return -1;
  let count = 0;
  let section: HTMLElement[] = [];
  let heading: HTMLElement | undefined;
  const finish = () => {
    const whole = heading ? hits(heading) : false;
    let any = false;
    for (const el of section) {
      if (whole) {
        any = true;
        count++;
        continue;
      }
      if (el.classList.contains('card')) {
        let inCard = false;
        for (const child of [...el.children] as HTMLElement[]) {
          if (hits(child)) {
            inCard = true;
            count++;
          } else child.dataset.hide = '1';
        }
        if (!inCard) el.dataset.hide = '1';
        any ||= inCard;
      } else if (hits(el)) {
        any = true;
        count++;
      } else el.dataset.hide = '1';
    }
    if (heading && !any) heading.dataset.hide = '1';
  };
  for (const el of all) {
    if (el.dataset.keep || el.tagName === 'HEADER' || el.classList.contains('topbar')) continue;
    if (el.dataset.searchHide) {
      el.dataset.hide = '1';
      continue;
    }
    if (el.classList.contains('eyebrow')) {
      finish();
      section = [];
      heading = el;
    } else section.push(el);
  }
  finish();
  return count;
}

/** "Erase everything and start fresh" (0.8.2): asks twice, then wipes this phone and reopens Restock. */
async function eraseAll() {
  // 0.8.5: the owner phone can't just vanish, or nobody could add or remove phones again.
  if (isNative()) {
    const info = await syncInfo().catch(() => undefined);
    if (info?.paired && info.isOwner && (info.members ?? []).some((m) => !m.me)) {
      await confirmAction('Make another phone the owner first', {
        detail:
          'This is the household\'s owner phone. In Settings → Sync and backups → Phones and sharing, tap another phone and choose "Make this the owner phone", sync once, then erase this one. Or remove the other phones first.',
        action: 'OK',
        danger: false,
      });
      return;
    }
  }
  const first = await confirmAction('Erase everything on this phone?', {
    detail:
      "Every item, list, price, card, receipt and setting is deleted from this phone, you're signed out of the shops inside Restock, and it leaves your household if it's in one (and your Restock server, where what it moved stays). Other phones keep their things. Export a backup first if you might want any of it back.",
    action: 'Continue',
  });
  if (!first) return;
  const second = await confirmAction('Are you sure? This deletes all your data', {
    detail: "Restock will start again from its first screen. This can't be undone.",
    action: 'Erase everything',
  });
  if (!second) return;
  if (isNative()) {
    // 0.9.2: off the Restock server first, without bringing its photos back (they'd only be erased).
    await RestockNative.syncStopServer({ bringBack: false }).catch(() => undefined);
    // Tell the household this phone is going, if it's here; then stop everything in the background.
    await RestockNative.syncLeave().catch(() => undefined);
    await RestockNative.eraseNative().catch(() => undefined);
    await RestockNative.scheduleChecks({ enabled: false, intervalHours: 12 }).catch(() => undefined);
    await RestockNative.scheduleRecalls({ enabled: false }).catch(() => undefined);
    for (const dir of ['receipts', 'backups', 'cards']) await RestockNative.deleteAppDir({ path: dir }).catch(() => undefined);
  }
  await eraseEverything();
  try {
    localStorage.clear();
  } catch {
    // nothing kept there
  }
  // Let the last write land (the browser preview saves a moment later), then open Restock fresh.
  await new Promise((r) => setTimeout(r, 800));
  window.location.reload();
}

export function SettingsScreen() {
  useSettingsDraft(); // 0.9.5 (save)
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const cardCount = useLive(async () => (await allCards()).length + (await allGiftCards()).length, []); // 0.9.6 (cards): loyalty and gift
  const sync = useLive(syncInfo, []);
  // 0.9.3: Sync now in Sync and backups shows its result straight away.
  const [syncNowInfo, setSyncShown] = useState<SyncInfo>();
  const syncShown = syncNowInfo ?? sync;
  // …until the next look: then what's live again (leaving the household, say, shows straight away).
  useEffect(() => setSyncShown(undefined), [sync]);
  // 0.9.1: how much price history a backup holds.
  const span = useLive(priceHistorySpan, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState<'privacy' | 'disclaimer'>();
  const [picking, setPicking] = useState<BackupSummary>();
  const [testing, setTesting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<number>();
  const screen = useRef<HTMLDivElement>(null);
  // 0.9.3: Home Assistant's row says whether it's on for this phone, or which phone does it.
  const ha = useLive(getHaConfig, []);
  const haWho = useLive(haPhone, []);
  const haSummary =
    haWho?.inHousehold && haWho.device && !haWho.mine
      ? `Syncs through ${phoneLabel(haWho.name)}`
      : ha?.enabled
        ? `On for this phone · ${ha.entity}`
        : 'Your shopping list in Home Assistant, both ways';
  useEffect(() => {
    if (!screen.current) return;
    // Searching looks inside the rows that fold away too.
    if (query.trim()) screen.current.querySelectorAll('details').forEach((d) => (d.open = true));
    setMatches(filterSettings(screen.current, query));
  }, [query, settings, cardCount]);
  if (!settings) return <div className="screen" />;

  const row = (title: string, sub: string, onClick: () => void) => (
    <button className="row" onClick={onClick}>
      <span className="grow">
        <span className="title">{title}</span>
        <span className="small">{sub}</span>
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );

  return (
    <div className="screen" ref={screen}>
      <TopBar title="Settings" />
      <div className="settings-search" data-keep="1">
        <Icon name="search" size={18} />
        <input
          className="input"
          type="search"
          placeholder="Search settings"
          aria-label="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery('')}>
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {query.trim() && matches === 0 && (
        <p className="small" data-keep="1">
          No settings match "{query.trim()}". Try another word, like "alerts", "colour" or "backup".
        </p>
      )}
      <nav className="chips jump" aria-label="Jump to" data-search-hide="1">
        {[
          ['s-stores', 'Shops'],
          ['s-sync', 'Sync and backups'],
          ...(serverMode ? [] : [['s-ha', 'Home Assistant']]),
          ['s-checks', 'Price checks'],
          ['s-list', 'Shopping list'],
          ['s-alerts', 'Alerts'],
          ['s-look', 'Colours'],
          ['s-a11y', 'Accessibility'],
          ['s-recalls', 'Recalls'],
          ['s-receipts', 'Receipts'],
          ['s-widgets', 'Widgets'],
          ['s-shared', 'Shared prices'],
          ['s-help', 'Help'],
          ['s-about', 'About and updates'],
          ['s-soon', 'Coming soon'],
          ['s-erase', 'Start fresh'],
        ].map(([id, label]) => (
          <button key={id} className="chip" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {label}
          </button>
        ))}
      </nav>

      <div className="eyebrow" id="s-stores">
        My shops
      </div>
      <div className="card flush">
        {row('Setup', `${TILES.filter((t) => tileStatus(settings, t.id, syncShown).ok).length} of ${TILES.length} done`, () => nav.push({ name: 'setup' }))}
        {/* 0.9.8: one row per tab of My shops; sign-ins and stock are on each shop's own row there. */}
        {row('Supermarkets', `${shopSummary(settings, 'pantry')} · ${shopAccountsSummary(settings)}`, () => nav.push({ name: 'stores', section: 'pantry' }))}
        {row('Bottle shops (Keg tab)', shopSummary(settings, 'keg'), () => nav.push({ name: 'stores', section: 'keg' }))}
        {row('Chemists (Health tab)', shopSummary(settings, 'pharmacy'), () => nav.push({ name: 'stores', section: 'pharmacy' }))}
        {row('Cards', cardCount ? `${cardCount} added` : 'Loyalty and gift cards', () => nav.push({ name: 'cards' }))}
        {row('Catalogues', 'This week at your supermarkets', () => nav.push({ name: 'catalogues' }))}
      </div>

      {/* 0.9.1: sync and backups in one place. Sync keeps phones the same; backups are how you go back. */}
      <div className="eyebrow" id="s-sync">
        Sync and backups
      </div>
      {/* 0.9.3: the household on top, how the phones sync, then backups. Any of the three counts as kept elsewhere. */}
      <SyncOverview settings={settings} info={syncShown} onInfo={setSyncShown} />
      <p className="small group-note">Sync keeps your phones the same, mistakes included. Backups let you go back.</p>

      <h3 className="group-head" id="s-backups">
        Backups
      </h3>
      <div className="card flush">
        <button className="row" onClick={() => setExporting(true)}>
          <span className="grow">
            <span className="title">Export a backup</span>
            <span className="small">
              Pick what goes in: everything, or just some tabs, lists, cards or settings. {pricesIn(settings, span)} Keep it private.
            </span>
          </span>
        </button>
      </div>
      <AutoBackupSettings settings={settings} />
      <div className="card flush">
        <button className="row" onClick={() => fileRef.current?.click()}>
          <span className="grow">
            <span className="title">Restore a backup</span>
            <span className="small">Pick what to bring back: pantry, shopping list, cards or settings</span>
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
              setPicking(await readBackupFile(file));
            } catch (err) {
              nav.toast(err instanceof Error ? err.message : 'Could not read that file');
            }
          }}
        />
        <button
          className="row"
          onClick={async () => {
            try {
              await shareCsv();
            } catch (e) {
              nav.toast(`Couldn't make the spreadsheets: ${e instanceof Error ? e.message : e}`);
            }
          }}
        >
          <span className="grow">
            <span className="title">Export as spreadsheets (CSV)</span>
            <span className="small">Your pantry, shopping list and price history, for Excel, Google Sheets, LibreOffice or Numbers.</span>
          </span>
        </button>
        {/* 0.9.8: what only the server's web page does is shown here too, greyed, saying where. */}
        {!serverMode && (
          <div className="row" aria-disabled="true" style={{ opacity: 0.55 }}>
            <span className="grow">
              <span className="title">Import data</span>
              <span className="small">On your Restock server's web page (Data tab): adds products and prices from a file.</span>
            </span>
          </div>
        )}
      </div>

      {/* 0.9.3: the shopping list with Home Assistant, from this phone. Phones only. */}
      {!serverMode && (
        <>
          <div className="eyebrow" id="s-ha">
            Home Assistant
          </div>
          <div className="card flush">
            {row('Home Assistant', haSummary, () => nav.push({ name: 'homeAssistant' }))}
          </div>
        </>
      )}

      <div className="eyebrow" id="s-checks">
        Price checks
      </div>
      <PriceCheckSettings settings={settings} />
      <div className="card flush">
        <label className="check">
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Keep price history for
            </span>
            <span className="small">
              Longer means Restock knows each item's usual price and sale pattern better. It only takes a few megabytes on your phone either way,
              and backups include all of it.
            </span>
          </span>
          <select
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
            value={settings.historyWeeks}
            aria-label="Keep price history for"
            onChange={async (e) => {
              const weeks = parseInt(e.target.value, 10);
              if (weeks < settings.historyWeeks) {
                // 0.9.2: with a Restock server, older prices move there instead of being deleted.
                const onServer = await serverKeepsHistory();
                const ok = await confirmAction(`Keep only ${historyLabel(weeks)} of prices on this phone?`, {
                  detail: onServer
                    ? `Prices older than ${historyLabel(weeks)} move to your Restock server, and come off this phone once it has them. Each item keeps its latest price. Prices from shops on tabs this phone doesn't sync are deleted, as without a server.`
                    : `Prices older than ${historyLabel(weeks)} are deleted now. Each item keeps its latest price, and sample items aren't touched.`,
                  action: onServer ? 'Move older prices' : 'Delete older prices',
                  danger: !onServer,
                });
                if (!ok) return;
              }
              await updateSettings({ historyWeeks: weeks });
              // 0.9.5 (save): older prices go once it's saved.
              await afterSave('history', async (s) => {
                const removed = await pruneHistory(s.historyWeeks);
                if (removed) nav.toast(`Removed ${removed} older price${removed === 1 ? '' : 's'}`);
              });
            }}
          >
            {HISTORY_WEEKS.map((w) => (
              <option key={w} value={w}>
                {historyLabel(w)}
                {w === 8 ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="eyebrow" id="s-list">
        Shopping list
      </div>
      <div className="card flush">
        <label className="row field-row">
          <span className="grow">
            <span className="title">Shop around if it saves at least</span>
            <span className="small">
              Below this, a shop that has everything on your list is recommended instead, so you're not making extra stops for a few cents.
            </span>
            <select
              className="input"
              value={String(settings.shopAroundMin ?? 1)}
              onChange={(e) => void updateSettings({ shopAroundMin: Number(e.target.value) })}
              aria-label="Shop around if it saves at least"
            >
              {SHOP_AROUND_MINS.map((v) => (
                <option key={v} value={String(v)}>
                  {v === 0 ? 'Any saving' : money(v)}
                  {v === 1 ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>

      <div className="eyebrow" id="s-alerts">
        Notifications
      </div>
      <NotificationSettings settings={settings} />

      <Explain title="How Restock judges a sale">
        {/* 0.9.0: says what the code does (verdict.ts computeStats and judge). */}
        <p>
          Each product's <strong>usual price</strong> is the middle of the regular prices Restock has seen for it over the history you keep (
          {historyLabel(settings.historyWeeks)}
          {settings.historyWeeks === 8 ? ' unless you change it' : ''}). Until it has seen one at a regular price, it goes by the shop's "was" price.
          {settings.marketData.enabled ? ' For its first 4 weeks or so, shared price history fills in.' : ''} Member prices only count if you've added that
          shop's card.
        </p>
        <p>
          Only this week's specials (Wednesday to Tuesday) count as on special. An older special, or a lower price last checked over {STALE_DAYS} days
          ago, isn't called a deal until prices are checked again.
        </p>
        <p>
          Small saving: any drop under {GOOD_SALE * 100}% · On special: {GOOD_SALE * 100}%+ · Great deal: {GREAT_SALE * 100}%+. "Wait" means it's been at
          least 5% cheaper recently (never at half price or better). Each pantry item picks which of these send an alert.
        </p>
        <p>
          Multi-buys like "2 for $5" count at their price each ($2.50), and your shopping list only uses that price when you're buying the full set.
          Swaps to bigger packs only happen for items you've said yes to bulk packs.
        </p>
      </Explain>

      <div className="eyebrow" id="s-look">
        Look and colours
      </div>
      <LookSettings settings={settings} />

      <div className="eyebrow" id="s-a11y">
        Accessibility
      </div>
      <AccessibilitySettings settings={settings} />

      <div className="eyebrow" id="s-recalls">
        Recall alerts
      </div>
      <div className="card flush">{row('Recall alerts', recallSummary(settings), () => nav.push({ name: 'recalls' }))}</div>

      <div className="eyebrow" id="s-receipts">
        Receipts
      </div>
      <ReceiptsSettings settings={settings} />

      <div className="eyebrow" id="s-widgets">
        Home screen widgets
      </div>
      <Fold title="Home screen widgets" sub="Deals, shopping list and quick actions">
        <WidgetSettings settings={settings} />
      </Fold>

      <div className="eyebrow" id="s-shared">
        Shared prices <span className="tag normal beta">Beta</span>
      </div>
      <SharePrices settings={settings} />
      <Fold title="Judge new items from day one" sub={settings.marketData.enabled ? 'On' : 'Off'}>
        <SharedHistory settings={settings} />
      </Fold>

      <div className="eyebrow" id="s-help">
        Troubleshooting
      </div>
      <div className="card flush">
        {row('Test connections', 'Try a search at each shop and see what happens', () => setTesting(true))}
        {row('Diagnostics', 'What went wrong lately, the search test and search details', () => nav.push({ name: 'diagnostics' }))}
        {row('Permissions', 'Notifications, alarms, camera, location', () => nav.push({ name: 'permissions' }))}
        <details className="pick-more fold-inline">
          <summary>
            <span className="grow">Advanced: shop connections</span>
            <Icon name="chevron" size={18} />
          </summary>
          <label className="check">
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Shop connections
              </span>
              <span className="small">
                Automatic asks shops directly and switches to a hidden in-app browser if that fails. Coles always uses the browser.
              </span>
            </span>
            <select
              className="input"
              style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
              value={settings.connection}
              onChange={(e) => updateSettings({ connection: e.target.value as Settings['connection'] })}
              aria-label="Shop connections"
            >
              <option value="auto">Automatic</option>
              <option value="browser">Always browser</option>
            </select>
          </label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="grow" style={{ minWidth: 200 }}>
              <span className="title">Shop keeps saying it's blocked?</span>
              <span className="small">Open its website here once and tick its "I'm a person" box.</span>
            </span>
          </div>
          {shopGroups(settings).map(({ section, chains }) => (
            <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 14px 12px' }}>
              <span className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name={section} size={15} /> {GROUP_LABEL[section]}
              </span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {chains.map((c) => (
                  <OpenStoreButton
                    key={c}
                    chain={c}
                    label={chainName(c)}
                    onDone={() => nav.toast(`Thanks. ${chainName(c)} should work again now.`)}
                  />
                ))}
              </span>
            </div>
          ))}
        </details>
      </div>
      <div className="card flush">
        {settings.demoLoaded ? (
          <button
            className="row"
            onClick={async () => {
              await removeDemo();
              nav.toast('Sample items removed');
            }}
          >
            <span className="grow">
              <span className="title" style={{ color: 'var(--red-ink)' }}>
                Remove sample items
              </span>
              <span className="small">Your own items stay</span>
            </span>
          </button>
        ) : (
          <button
            className="row"
            onClick={async () => {
              await loadDemo();
              nav.toast('Sample items added');
            }}
          >
            <span className="grow">
              <span className="title">Add sample items</span>
              <span className="small">Seven made-up items with price history, to see how verdicts work</span>
            </span>
          </button>
        )}
        <button
          className="row"
          onClick={async () => {
            nav.pop();
            await startTour();
          }}
        >
          <span className="grow">
            <span className="title">Take the tour again</span>
            <span className="small">A look round with sample items, removed when it ends</span>
          </span>
        </button>
      </div>

      <div className="eyebrow" id="s-about">
        About and updates
      </div>
      <div className="card flush">
        <UpdateRows settings={settings} />
        {row('Privacy policy', `Updated ${legal.updated}`, () => setReading('privacy'))}
        {row('Fine print', 'Not affiliated with the shops, no warranty', () => setReading('disclaimer'))}
      </div>

      <div className="eyebrow" id="s-soon">
        Coming soon
      </div>
      <Fold title="What's planned" sub="Stock at home, spending, hosted sync, iPhone and more">
        <ComingSoon />
      </Fold>

      <div className="eyebrow" id="s-erase">
        Start fresh
      </div>
      <div className="card flush">
        <button className="row" onClick={() => void eraseAll()}>
          <Icon name="trash" size={18} />
          <span className="grow">
            <span className="title" style={{ color: 'var(--red-ink)' }}>
              Erase everything and start fresh
            </span>
            <span className="small">Deletes all your items, lists, prices, cards, receipts and settings from this phone. It can't be undone.</span>
          </span>
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
        <Logo size={40} />
      </div>
      <p className="small" style={{ textAlign: 'center' }}>
        Restock {version} release candidate · free and open source
        <br />
        Your data stays on this phone, and your household's phones only if you share
        <br />
        <a href="https://github.com/d-plenty/Restock" target="_blank" rel="noreferrer">
          Source code and bug reports on GitHub
        </a>
      </p>
      {/* 0.9.5 (save): "Unsaved changes · Save settings", above the tabs. */}
      <SaveBar />
      {reading && <LegalSheet doc={reading} onClose={() => setReading(undefined)} />}
      {testing && <ConnectionsSheet settings={settings} onClose={() => setTesting(false)} />}
      {exporting && <ExportSheet onClose={() => setExporting(false)} onDone={(m) => nav.toast(m)} />}
      {picking && (
        <RestoreSheet
          summary={picking}
          onClose={() => setPicking(undefined)}
          onDone={(what) => {
            setPicking(undefined);
            nav.toast(`Restored your ${what}`);
            // 0.8.2: backups never hold the household; offer to join it again.
            void syncInfo().then(async (i) => {
              if (i.paired || !isNative()) return;
              const join = await confirmAction('Sync this phone with your household?', {
                detail: "Backups don't include the household, so a restored phone joins again with a new code from the owner phone.",
                action: 'Join a household',
                danger: false,
              });
              if (join) nav.push({ name: 'sync' });
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * Beta: price history from hotprices.org, an open-source project that records Coles and
 * Woolworths prices daily, so new items can be judged from day one.
 */
/**
 * Share prices about products (0.9.0). On unless turned off. For now it only adds a "shared prices"
 * section to your own backups (sharedPrices.ts); nothing is sent anywhere yet.
 */
function SharePrices({ settings }: { settings: Settings }) {
  const on = settings.sharePrices !== 'no';
  return (
    <div className="card flush">
      <label className="check">
        <input
          type="checkbox"
          className="switch"
          checked={on}
          onChange={(e) => void updateSettings({ sharePrices: e.target.checked ? 'yes' : 'no' })}
        />
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title">Share prices about products</span>
          <span className="small">{on ? 'On' : 'Off'} · for now, only saved in your own backups</span>
        </span>
      </label>
      <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="small">
          The plan is a free, open price list anyone can search: what things cost at each shop, and when. It's meant to be decentralised. The
          phones and computers running Restock share prices with each other, instead of one central server collecting them. The prices will
          never be sold.
        </p>
        <p className="small">
          <strong>For now nothing leaves your phone.</strong> Restock adds a "shared prices" part to the backups you make, ready for when sharing
          starts. Before any version sends prices anywhere, it will ask you first, and nothing is sent unless you say yes.
        </p>
        <p className="small">
          <strong>What's in it:</strong> for each product Restock has checked, the shop, name, brand, size and barcode, and each price with the
          usual price, any special or multi-buy, and the day. <strong>Never:</strong> who you are, your cards, your branch or location,
          your shopping list or what you ticked off, receipts, or anything you type about yourself.
        </p>
      </div>
    </div>
  );
}

function SharedHistory({ settings }: { settings: Settings }) {
  const nav = useNav();
  const info = useLive(marketInfo, []);
  const [progress, setProgress] = useState<string>();
  const md = settings.marketData;

  const download = async (onlyUnmetered = false) => {
    setProgress('Starting…');
    try {
      const r = await downloadMarket(
        (chain, bytes, products) => setProgress(`${chainName(chain)}: ${megabytes(bytes)} downloaded, ${products.toLocaleString()} products so far`),
        { onlyUnmetered },
      );
      if (r.waitingForWifi) {
        nav.toast("You're on mobile data, so it'll download on Wi-Fi. Tap Download now to get it anyway.");
        return;
      }
      const failed = Object.entries(r.errors);
      nav.toast(
        failed.length
          ? `Got ${r.products.toLocaleString()} products. ${failed.map(([c, e]) => `${chainName(c)}: ${e}`).join('. ')}`
          : `Shared price history for ${r.products.toLocaleString()} products (${megabytes(r.bytes)})`,
      );
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(undefined);
    }
  };

  return (
    <div className="card flush">
      <label className="check">
        <input
          type="checkbox" className="switch"
          checked={md.enabled}
          onChange={async (e) => {
            const enabled = e.target.checked;
            await updateSettings({ marketData: { ...md, enabled } });
            // 0.9.5 (save): the first download starts once it's saved.
            await afterSave('market', (s) => {
              if (s.marketData.enabled && !info?.count) void download(s.marketData.wifiOnly);
            });
          }}
        />
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            Judge new items from day one
          </span>
          <span className="small">
            Downloads months of Coles and Woolworths price history from {MARKET_SOURCE}, an open-source price tracker, and keeps a short summary per
            product. It's {MARKET_SIZE_TEXT} each time, about once a week. Everyone downloads the same file, so it can't tell what you track. Aldi
            isn't covered.
          </span>
        </span>
      </label>
      {md.enabled && (
        <>
          <label className="check">
            <input type="checkbox" className="switch" checked={md.wifiOnly} onChange={(e) => updateSettings({ marketData: { ...md, wifiOnly: e.target.checked } })} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Only on Wi-Fi
              </span>
              <span className="small">Downloads wait for Wi-Fi. Download now always goes ahead.</span>
            </span>
          </label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span className="grow" style={{ minWidth: 180 }}>
              <span className="title" style={{ fontSize: 15 }}>
                {info?.count ? `${info.count.toLocaleString()} products` : 'Not downloaded yet'}
              </span>
              <span className="small">
                {progress ??
                  (info?.count
                    ? `Updated ${timeAgo(info.updatedAt)}${info.lastTry?.bytes ? ` · last download ${megabytes(info.lastTry.bytes)}` : ''}`
                    : 'Refreshes weekly after a background price check.')}
              </span>
            </span>
            <button className="btn small" disabled={!!progress} onClick={() => download()}>
              <Icon name="refresh" size={16} /> {progress ? 'Downloading…' : 'Download now'}
            </button>
          </div>
        </>
      )}
      {!md.enabled && info && info.count > 0 && (
        <button
          className="row"
          onClick={async () => {
            await removeMarket();
            nav.toast('Shared price history removed');
          }}
        >
          <span className="grow">
            <span className="title" style={{ color: 'var(--red-ink)' }}>
              Remove downloaded history
            </span>
            <span className="small">{info.count.toLocaleString()} product summaries are still on this phone</span>
          </span>
        </button>
      )}
    </div>
  );
}

/** Try each store and show whether it works, how long it took, or what went wrong. */
const GROUP_LABEL: Record<Section, string> = { pantry: 'Groceries', keg: 'Keg', pharmacy: 'Health' };

/** The shops you use, by tab (one per website, so Liquorland's three shops show once). Tabs that are off are left out. */
function shopGroups(settings: Settings): { section: Section; chains: StoreChain[] }[] {
  return activeSections(settings)
    .map((section) => ({ section, chains: searchChainsIn(settings.enabledChains, section) }))
    .filter((g) => g.chains.length > 0);
}

export function ConnectionsSheet({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const groups = shopGroups(settings);
  const chains: StoreChain[] = groups.flatMap((g) => g.chains);
  const [results, setResults] = useState<ConnectionTest[]>();
  const health = useLive(getHealth, []);
  const run = async () => {
    setResults(undefined);
    setResults(await testConnections(chains, Object.fromEntries(chains.map((c) => [c, settings.stores[c]?.storeId]))));
  };
  useEffect(() => {
    void run();
  }, []);
  return (
    <Sheet title="Test connections" onClose={onClose}>
      <p className="small">
        Restock searches each shop the same way it does when you add an item: supermarkets for "milk", bottle shops for "beer" and chemists for
        "paracetamol".
      </p>
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
                      {!r ? 'Testing…' : r.ok ? `Working: ${r.count} products in ${(r.ms / 1000).toFixed(1)} s` : `Not working: ${r.error}`}
                    </span>
                    {h?.lastOk && <span className="small">Last worked {timeAgo(h.lastOk)}</span>}
                    {r && !r.ok && <OpenStoreButton chain={c} onDone={run} />}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {!chains.length && <p className="small">No shops picked yet. Choose them in Settings → My shops.</p>}
      <button className="btn" disabled={!results} onClick={run}>
        <Icon name="refresh" size={18} /> Test again
      </button>
      <p className="small">
        Still failing? Try Shop connections → Always use the browser, or open the shop and tick "I'm not a robot" if it asks. If a shop keeps
        failing, please{' '}
        <a href="https://github.com/d-plenty/Restock/issues/new/choose" target="_blank" rel="noreferrer">
          report it on GitHub
        </a>{' '}
        with the error above.
      </p>
    </Sheet>
  );
}

/** Background price checks: on or off, how often, which day (Settings, and the setup tile, 0.8.0). */
export function PriceCheckSettings({ settings }: { settings: Settings }) {
  const setChecks = async (patch: { hours?: number; on?: boolean; weekday?: number; time?: string }) => {
    const s = await updateSettings({
      ...(patch.hours !== undefined ? { checkIntervalHours: patch.hours } : {}),
      ...(patch.weekday !== undefined ? { checkWeekday: patch.weekday } : {}),
      ...(patch.time !== undefined ? { checkTime: patch.time } : {}),
      ...(patch.on !== undefined ? { sync: { ...settings.sync, backgroundActivity: patch.on } } : {}),
    });
    // 0.9.5 (save): on a settings screen, once it's saved.
    await afterSave('checks', (saved) => syncBackgroundSchedule(saved).catch(() => undefined), s);
  };

  return (
    <>
      <div className="card flush">
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.sync.backgroundActivity} onChange={(e) => setChecks({ on: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Check prices in the background
            </span>
            <span className="small">Only on a network connection and when the battery isn't low.</span>
          </span>
        </label>
        <label
          className="check"
          style={settings.sync.backgroundActivity ? undefined : { opacity: 0.5 }}
          aria-disabled={!settings.sync.backgroundActivity || undefined}
        >
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              How often
            </span>
            <span className="small">Android may run it a few minutes late to save battery.</span>
          </span>
          <select
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
            value={settings.checkIntervalHours}
            disabled={!settings.sync.backgroundActivity}
            onChange={(e) => setChecks({ hours: parseInt(e.target.value, 10) })}
            aria-label="How often to check prices"
          >
            {CHECK_INTERVALS.map((h) => (
              <option key={h} value={h}>
                {intervalLabel(h)}
                {h === 24 ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label
          className="check"
          style={settings.sync.backgroundActivity ? undefined : { opacity: 0.5 }}
          aria-disabled={!settings.sync.backgroundActivity || undefined}
        >
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Price check time
            </span>
            <span className="small">
              {settings.checkIntervalHours === 6 || settings.checkIntervalHours === 12
                ? `Runs at ${dailyTimes({ intervalHours: settings.checkIntervalHours, time: settings.checkTime }).join(', ')}.`
                : 'Your phone\'s own time. If the phone is off then, it checks soon after it is back.'}{' '}
              Checking by hand doesn't change it.
            </span>
          </span>
          <input
            type="time"
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 10px', fontSize: 15 }}
            value={settings.checkTime ?? DEFAULT_CHECK_TIME}
            disabled={!settings.sync.backgroundActivity}
            onChange={(e) => {
              if (isCheckTime(e.target.value)) void setChecks({ time: e.target.value });
            }}
            aria-label="Price check time"
          />
        </label>
        {settings.checkIntervalHours >= 168 && (
          <label
            className="check"
            style={settings.sync.backgroundActivity ? undefined : { opacity: 0.5 }}
            aria-disabled={!settings.sync.backgroundActivity || undefined}
          >
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Which day
              </span>
              <span className="small">Wednesday recommended: that's when new specials start.</span>
            </span>
            <select
              className="input"
              style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
              value={settings.checkWeekday}
              disabled={!settings.sync.backgroundActivity}
              onChange={(e) => setChecks({ weekday: parseInt(e.target.value, 10) })}
              aria-label="Day for weekly price checks"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
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
            <span className="small">
              Which of your items are on special and roughly what you'd save, after the first price check that day. Wednesday is when new specials
              start.
            </span>
          </span>
          <select
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
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
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
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

function shopAccountsSummary(settings: Settings): string {
  // 0.9.8: only the shops you're signed in to, so the line stays short.
  const on = (['woolworths', 'coles', 'costco'] as const).filter((c) => settings.enabledChains.includes(c) && settings.accounts?.[c]?.signedIn);
  return on.length ? `Signed in to ${on.map((c) => ({ woolworths: 'Woolworths', coles: 'Coles', costco: 'Costco' })[c]).join(', ')}` : 'Not signed in to any shop';
}

/** A settings card that folds away until you open it (0.7.3), so the page isn't a wall of options. */
function Fold({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
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
      await saveNow({ updates: { notify: !!was?.notify, ...was, lastCheck: new Date().toISOString() } });
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
          <a className="small" href={found.pageUrl} target="_blank" rel="noreferrer">
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
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
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
