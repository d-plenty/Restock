import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openDatabase } from '../lib/boot';
import { wireSync } from '../lib/sync';
import { checkPrices, syncBackgroundSchedule } from '../lib/check';
import { getSettings, pruneHistory, refresh, updateSettings } from '../lib/db';
import { checkForUpdate, SELF_UPDATE, weeklyCheckDue } from '../lib/updates';
import { version as appVersion } from '../../package.json';
import { setConnectionMode } from '../stores/http';
import { applyTheme, syncInsets } from '../lib/theme';
import { scheduleReminders } from '../lib/notify';
import { useLive } from '../lib/useLive';
import { Announcer, closeTopLayer, Icon, layerHost, runBackHandlers } from './components';
import { isSectionTab, NavContext, type Nav, type Screen, type Tab } from './nav';
import { activeSections, type Section } from '../shops';
import { ConfirmHost } from './ConfirmHost';
import { ErrorBoundary } from './ErrorBoundary';
import { ScannerHost } from './Scanner';
import { AddScreen } from './screens/Add';
import { CardsScreen } from './screens/Cards';
import { CataloguesScreen } from './screens/Catalogues';
import { MyCatalogueScreen } from './screens/MyCatalogue';
import { PermissionsScreen } from './screens/Permissions';
import { HomeScreen } from './screens/Home';
import { HouseholdScreen } from './screens/Household';
import { ItemScreen } from './screens/Item';
import { ListScreen } from './screens/List';
import { Onboarding } from './screens/Onboarding';
import { SetupScreen } from './screens/Setup';
import { addShared } from '../lib/shared';
import { scanBarcode } from '../lib/barcode';
import { RestockNative } from '../lib/sql/native';
import { DiagnosticsScreen } from './screens/Diagnostics';
import { SpecialsScreen } from './screens/Specials';
import { ReceiptScreen, ReceiptsScreen } from './screens/Receipts';
import { RecallsScreen } from './screens/Recalls';
import { SoonScreen } from './screens/Soon';
import { TourHost } from './Tour';
import { maybeAutoBackup } from '../lib/autoBackup';
import { watchWidgets } from '../lib/widgets';
import { tidyReceipts } from '../lib/receipts';
import { PantryScreen } from './screens/Pantry';
import { SettingsScreen } from './screens/Settings';
import { StoresScreen } from './screens/Stores';
import { SyncScreen } from './screens/Sync';

const ALL_TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'pantry', label: 'Pantry', icon: 'pantry' },
  { id: 'keg', label: 'Keg', icon: 'keg' },
  { id: 'pharmacy', label: 'Pharmacy', icon: 'pharmacy' },
  { id: 'add', label: 'Add', icon: 'plus' },
  { id: 'list', label: 'List', icon: 'cart' },
];

/** 0.9.0: the whole app inside a safety net, so a screen that breaks shows a way out, not a blank page (ErrorBoundary.tsx). */
export default function App() {
  return (
    <ErrorBoundary>
      <RestockApp />
    </ErrorBoundary>
  );
}

function RestockApp() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string>();
  const [tab, setTab] = useState<Tab>('home');
  const [section, setSection] = useState<Section>('pantry');
  const [stack, setStack] = useState<Screen[]>([]);
  const [toastMsg, setToastMsg] = useState<string>();
  const [toastUndo, setToastUndo] = useState<(() => void | Promise<void>) | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const settings = useLive(() => (ready ? getSettings() : Promise.resolve(undefined)), [ready]);

  useEffect(() => {
    void syncInsets();
    // Re-measure after the system bars settle, and when the phone turns.
    const t = window.setTimeout(() => void syncInsets(), 800);
    const onResize = () => void syncInsets();
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // "Tell me when there's an update": once a week, when Restock opens (0.7.3).
  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(() => {
      void (async () => {
        const s = await getSettings();
        if (!SELF_UPDATE || !weeklyCheckDue(s.updates)) return;
        const info = await checkForUpdate(appVersion).catch(() => undefined);
        const told = info?.newer && s.updates?.told !== info.version ? info.version : undefined;
        await updateSettings({ updates: { notify: true, ...s.updates, lastCheck: new Date().toISOString(), ...(told ? { told } : {}) } });
        if (!told) return;
        const msg = `Restock ${told} is out. Update it in Settings → About and updates.`;
        if (Capacitor.isNativePlatform())
          await RestockNative.notify({ id: 4390, title: 'A Restock update is ready', body: msg }).catch(() => undefined);
        else setToastMsg(msg);
      })();
    }, 4000);
    return () => window.clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    openDatabase()
      .then(() => {
        wireSync();
        setReady(true);
      })
      .catch((e) => setBootError(e instanceof Error ? e.message : String(e)));
  }, []);

  const toast = useCallback((msg: string, undo?: () => void | Promise<void>) => {
    setToastMsg(msg);
    setToastUndo(() => undo);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(
      () => {
        setToastMsg(undefined);
        setToastUndo(undefined);
      },
      undo ? 4000 : 2800,
    );
  }, []);

  const nav: Nav = useMemo(
    () => ({
      tab,
      section,
      setTab: (t, sec) => {
        setStack([]);
        setTab(t);
        if (isSectionTab(t)) setSection(t);
        else if (sec) setSection(sec);
      },
      push: (s) => setStack((st) => [...st, s]),
      pop: () => setStack((st) => st.slice(0, -1)),
      toast,
    }),
    [tab, section, toast],
  );

  // Android back button: one thing per press. The scanner, then the top sheet or shopping mode,
  // then the top screen, then setup's own steps (useBackHandler), then Home, then leave.
  const stateRef = useRef({ stack, tab });
  stateRef.current = { stack, tab };
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = CapApp.addListener('backButton', () => {
      const { stack: st, tab: t } = stateRef.current;
      if (document.querySelector('.scanner')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      } else if (closeTopLayer()) return;
      else if (st.length) setStack(st.slice(0, -1));
      else if (runBackHandlers()) return;
      else if (t !== 'home') setTab('home');
      else CapApp.exitApp();
    });
    return () => {
      sub.then((s) => s.remove());
    };
  }, []);

  // Check prices when the app opens or comes back, if it's been a while.
  const onboarded = settings?.onboarded;

  // Something shared to Restock from another app, or an app icon shortcut (Scan, List, Receipt).
  useEffect(() => {
    if (!onboarded || !Capacitor.isNativePlatform()) return;
    const run = async (a: { action?: string; text?: string }) => {
      // nav.setTab also closes any open screens, so the tab asked for is what shows.
      if (a.action === 'share' && a.text) {
        nav.setTab('list');
        toast(await addShared(a.text));
      } else if (a.action === 'list') nav.setTab('list');
      else if (a.action === 'receipt') setStack((st) => [...st, { name: 'receipt' }]);
      else if (a.action === 'recalls') setStack((st) => [...st, { name: 'recalls' }]);
      else if (a.action === 'deals') nav.setTab('home');
      else if (a.action === 'scan') {
        const out = await scanBarcode();
        if (out.ok) setStack((st) => [...st, { name: 'add', barcode: out.code }]);
      }
    };
    void RestockNative.takeLaunchAction()
      .then(run)
      .catch(() => undefined);
    const sub = RestockNative.addListener('launchAction', (e) => void run(e));
    return () => {
      void sub.then((h) => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded]);
  // Tidy away prices older than the history setting, once per launch.
  useEffect(() => {
    if (!onboarded) return;
    void getSettings()
      .then((s) => pruneHistory(s.historyWeeks))
      .catch((e) => console.error('history tidy-up failed', e));
  }, [onboarded]);
  useEffect(() => {
    if (!onboarded || !Capacitor.isNativePlatform()) return;
    const maybeCheck = async () => {
      const s = await getSettings();
      if (!s.lastCheck || Date.now() - Date.parse(s.lastCheck) > s.checkIntervalHours * 3_600_000) {
        const r = await checkPrices();
        if (r.updated) toast(`Updated ${r.updated} price${r.updated === 1 ? '' : 's'}`);
      }
    };
    void maybeCheck().catch((e) => console.error('price check failed', e));
    // Kept separate so a problem with reminders can't stop background price checks, or the reverse.
    void getSettings().then((s) => {
      syncBackgroundSchedule(s).catch((e) => console.error('background schedule failed', e));
      scheduleReminders(s).catch((e) => console.error('reminders failed', e));
      RestockNative.scheduleRecalls({ enabled: s.recalls.enabled }).catch((e) => console.error('recall schedule failed', e));
    });
    void maybeAutoBackup().catch((e) => console.error('auto backup failed', e));
    void tidyReceipts().catch((e) => console.error('receipt tidy-up failed', e));
    const stopWidgets = watchWidgets();
    const sub = CapApp.addListener('resume', () => {
      // The background worker may have saved new prices while the app was closed.
      refresh();
      void maybeCheck().catch((e) => console.error('price check failed', e));
      void maybeAutoBackup().catch((e) => console.error('auto backup failed', e));
    });
    return () => {
      stopWidgets();
      sub.then((s) => s.remove());
    };
  }, [onboarded, toast]);

  if (bootError) {
    return (
      <div className="app">
        <div className="screen">
          <h1>Couldn't open your data</h1>
          <p className="small">{bootError}</p>
        </div>
      </div>
    );
  }
  if (!ready || !settings) return <div className="app" />;
  setConnectionMode(settings.connection);
  applyTheme(settings);

  if (!settings.onboarded) {
    return (
      <NavContext.Provider value={nav}>
        <div className="app">
          <div className="status-shade" aria-hidden />
          <Onboarding />
          {/* Setup tiles can open these (cards, shop accounts, sync) before setup is finished. */}
          {stack.length > 0 && (
            <div className="overlay">
              {stack[stack.length - 1].name === 'stores' && <StoresScreen section={(stack[stack.length - 1] as { section?: Section }).section} />}
              {stack[stack.length - 1].name === 'cards' && <CardsScreen />}
              {stack[stack.length - 1].name === 'sync' && <SyncScreen />}
              {stack[stack.length - 1].name === 'household' && <HouseholdScreen />}
              {stack[stack.length - 1].name === 'diagnostics' && <DiagnosticsScreen />}
              {stack[stack.length - 1].name === 'soon' && <SoonScreen id={(stack[stack.length - 1] as { id: string }).id} />}
            </div>
          )}
          <ConfirmHost />
          {/* 0.9.1: in the layer on <body>, so they still work while a sheet shuts the app off (components.tsx Sheet). */}
          {createPortal(
            <>
              <ScannerHost />
              <Announcer text={toastMsg} />
              {toastMsg && (
                <div className="toast" onClick={() => setToastMsg(undefined)}>
                  {toastMsg}
                </div>
              )}
            </>,
            layerHost(),
          )}
        </div>
      </NavContext.Provider>
    );
  }

  const top = stack[stack.length - 1];
  // Keg and Pharmacy only show when they're switched on and have a shop picked.
  const on = activeSections(settings);
  // A tab can also be left out of the bar while its shops stay in use (Add, shopping list).
  const inBar = on.filter((sec) => sec === 'pantry' || !settings.hiddenTabs?.includes(sec));
  const tabs = ALL_TABS.filter((t) => !isSectionTab(t.id) || inBar.includes(t.id));
  const shownTab: Tab = isSectionTab(tab) && !inBar.includes(tab) ? 'pantry' : tab;
  const addSection: Section = on.includes(section) ? section : 'pantry';

  return (
    <NavContext.Provider value={nav}>
      <div className="app">
        {/* Covers the status bar, so pages don't scroll up underneath the clock and battery. */}
        <div className="status-shade" aria-hidden />
        {shownTab === 'home' && <HomeScreen />}
        {isSectionTab(shownTab) && <PantryScreen key={shownTab} section={shownTab} />}
        {shownTab === 'add' && <AddScreen key={`add-tab-${addSection}`} section={addSection} />}
        {shownTab === 'list' && <ListScreen />}

        <nav className="tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
          {tabs.map((t) =>
            t.id === 'add' ? (
              <button key={t.id} className="tab centre-add" aria-current={shownTab === 'add' ? 'page' : undefined} onClick={() => nav.setTab('add')}>
                <span className="bubble">
                  <Icon name="scan" size={26} stroke={2.4} />
                </span>
                {t.label}
              </button>
            ) : (
              <button
                key={t.id}
                className={`tab${t.id === 'pharmacy' ? ' pharm' : ''}`}
                aria-current={shownTab === t.id ? 'page' : undefined}
                onClick={() => nav.setTab(t.id)}
              >
                <Icon name={t.icon} />
                {t.label}
              </button>
            ),
          )}
        </nav>

        {top && (
          <div className="overlay">
            {top.name === 'item' && <ItemScreen key={top.groupId} groupId={top.groupId} />}
            {top.name === 'add' && (
              <AddScreen
                key={`add-${stack.length}`}
                barcode={top.barcode}
                attachTo={top.attachTo}
                as={top.as}
                another={top.another}
                query={top.query}
                onlyChain={top.chain}
                section={top.section ?? addSection}
                forList={top.forList}
                replaceEntry={top.replaceEntry}
                overlay
              />
            )}
            {top.name === 'catalogues' && <CataloguesScreen />}
            {top.name === 'mycatalogue' && <MyCatalogueScreen />}
            {top.name === 'permissions' && <PermissionsScreen />}
            {top.name === 'settings' && <SettingsScreen />}
            {top.name === 'stores' && <StoresScreen section={top.section} />}
            {top.name === 'cards' && <CardsScreen />}
            {top.name === 'sync' && <SyncScreen />}
            {top.name === 'household' && <HouseholdScreen />}
            {top.name === 'setup' && <SetupScreen />}
            {top.name === 'diagnostics' && <DiagnosticsScreen />}
            {top.name === 'specials' && <SpecialsScreen />}
            {top.name === 'receipts' && <ReceiptsScreen />}
            {top.name === 'receipt' && <ReceiptScreen key={top.id ?? 'new'} id={top.id} />}
            {top.name === 'recalls' && <RecallsScreen />}
            {top.name === 'soon' && <SoonScreen id={top.id} />}
          </div>
        )}

        <TourHost />
        <ConfirmHost />
        {/* 0.9.1: in the layer on <body>, so the scanner, the toast and its Undo, and what screen readers
            hear still work while a sheet shuts the app off (components.tsx Sheet). */}
        {createPortal(
          <>
            <ScannerHost />
            <Announcer text={toastMsg} />
            {toastMsg && (
              <div
                className="toast"
                // Tap it to make it go away, so it never sits over a button you need (0.7.3).
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('.toast-undo')) return;
                  setToastMsg(undefined);
                  setToastUndo(undefined);
                }}
              >
                <span style={{ flex: 1 }}>{toastMsg}</span>
                {toastUndo && (
                  <button
                    className="toast-undo"
                    onClick={async () => {
                      const run = toastUndo;
                      setToastMsg(undefined);
                      setToastUndo(undefined);
                      await run();
                    }}
                  >
                    Undo
                  </button>
                )}
              </div>
            )}
          </>,
          layerHost(),
        )}
      </div>
    </NavContext.Provider>
  );
}
