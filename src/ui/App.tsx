import { App as CapApp } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { placeToast } from './toastLift';
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
import { RestockServerScreen } from './screens/RestockServer';
import { HomeAssistantScreen } from './screens/HomeAssistant';
import { wireHomeAssistant } from '../lib/homeAssistant';
import { serverMode, serverUi, useDesktopWidth } from '../server-mode/flag';
import { onUndo, undo as undoStep, undoneText } from '../lib/undo'; // 0.9.5 (undo)
import { canLeave, getSettings as shownSettings, hasUnsaved } from '../lib/settingsDraft'; // 0.9.5 (save)
import { askLeave } from '../lib/confirm'; // 0.9.5 (save)

const ALL_TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'pantry', label: 'Pantry', icon: 'pantry' },
  { id: 'keg', label: 'Keg', icon: 'keg' },
  { id: 'pharmacy', label: 'Health', icon: 'pharmacy' },
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
  // 0.9.5 (look): the toast stays clear of the bars at the bottom of the screen (toastLift.ts).
  const toastRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!toastMsg) return;
    placeToast(toastRef.current);
    const t = window.setInterval(() => placeToast(toastRef.current), 200);
    return () => window.clearInterval(t);
  }, [toastMsg]);
  const [toastUndo, setToastUndo] = useState<(() => void | Promise<void>) | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const settings = useLive(() => (ready ? getSettings() : Promise.resolve(undefined)), [ready]);
  // 0.9.5 (save): the look and colours show while they're being changed, before Save (and go back on Discard).
  const look = useLive(() => (ready ? shownSettings() : Promise.resolve(undefined)), [ready]);
  // 0.9.3: the web app on a Restock server, in a wide window: the desktop layout. Always false on a phone.
  const desk = useDesktopWidth();

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

  // "Tell me when there's an update": when Restock opens, every 24 hours, or every 7 days if picked (0.9.3).
  useEffect(() => {
    if (!ready || serverMode) return;
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
          await RestockNative.notify({ id: 4390, title: 'A Restock update is ready', body: msg, action: 'updates' }).catch(() => undefined);
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

  // 0.9.5 (undo): a message with Undo stays 5 seconds, and waits while it's touched or focused.
  const toastLeft = useRef(0);
  const toastHeld = useRef(false);
  const startToastTimer = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    if (toastHeld.current) return;
    toastTimer.current = window.setTimeout(() => {
      setToastMsg(undefined);
      setToastUndo(undefined);
    }, toastLeft.current);
  }, []);
  const toast = useCallback(
    (msg: string, undo?: () => void | Promise<void>) => {
      setToastMsg(msg);
      setToastUndo(() => undo);
      toastHeld.current = false;
      toastLeft.current = undo ? 5000 : 2800;
      startToastTimer();
    },
    [startToastTimer],
  );
  // 0.9.12: a button whose work fails without saying so (an error nobody caught) says something
  // went wrong, instead of seeming to do nothing. Network hiccups that the code already expects are
  // caught where they happen; this is the safety net for the rest.
  useEffect(() => {
    const onReject = (e: PromiseRejectionEvent) => {
      const why = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '');
      console.error('unhandled', e.reason);
      if (!why || /abort/i.test(why)) return;
      toast(`That didn't work: ${why.length > 120 ? `${why.slice(0, 117)}…` : why}`);
    };
    window.addEventListener('unhandledrejection', onReject);
    return () => window.removeEventListener('unhandledrejection', onReject);
  }, [toast]);
  const holdToast = useCallback(
    (hold: boolean) => {
      toastHeld.current = hold;
      if (hold) window.clearTimeout(toastTimer.current);
      else {
        toastLeft.current = Math.max(toastLeft.current, 2500);
        startToastTimer();
      }
    },
    [startToastTimer],
  );
  // 0.9.5 (undo): every undoable action (undo.ts) offers Undo here. In the wide web layout the
  // sidebar has its own big Undo button instead (Desktop.tsx UndoFoot).
  const deskRef = useRef(desk);
  deskRef.current = desk;
  useEffect(
    () =>
      onUndo((e) => {
        if (e.kind === 'added' && !deskRef.current)
          toast(e.step.label, async () => {
            const r = await undoStep(e.step.id);
            if (r) toast(undoneText(r));
          });
        else if (e.kind === 'undone' && deskRef.current) toast(undoneText(e));
      }),
    [toast],
  );

  // 0.9.5 (undo): on the web, Ctrl+Z (Cmd+Z on a Mac) undoes the last change, outside text boxes.
  useEffect(() => {
    if (!serverMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color)$/.test((t as HTMLInputElement).type)));
      if (typing) return;
      e.preventDefault();
      void undoStep().then((r) => {
        if (r && !deskRef.current) toast(undoneText(r));
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast]);

  // 0.9.5 (save): leaving a settings screen with changes not saved asks first (settingsDraft.ts).
  const leave = useCallback((go: () => void) => {
    if (!hasUnsaved()) return go();
    void canLeave(askLeave).then((ok) => ok && go());
  }, []);

  // 0.9.8: each screen keeps its scroll place. Opening a screen on top notes where the one below was;
  // coming back puts it there again (Settings, after Restore a backup or Recall alerts, say).
  const scrolls = useRef<number[]>([]);
  const topScroller = (): HTMLElement | null => {
    const all = [...document.querySelectorAll<HTMLElement>('.screen')];
    return all.length ? all[all.length - 1] : null;
  };
  const noteScroll = (depth: number) => {
    scrolls.current[depth] = topScroller()?.scrollTop ?? 0;
  };
  const restoreScroll = (depth: number) => {
    const y = scrolls.current[depth];
    if (!y) return;
    const leaving = topScroller(); // the screen being closed: never the one to scroll
    const until = Date.now() + 1500; // the screen may still be loading what it shows
    const tryIt = () => {
      const el = topScroller();
      if (el && el !== leaving) {
        el.scrollTop = y;
        if (Math.abs(el.scrollTop - y) < 2) return;
      }
      if (Date.now() < until) window.setTimeout(tryIt, 60);
    };
    window.requestAnimationFrame(tryIt);
  };
  const pushScreen = (s: Screen) =>
    setStack((st) => {
      noteScroll(st.length);
      return [...st, s];
    });
  const popScreen = () =>
    setStack((st) => {
      const next = st.slice(0, -1);
      restoreScroll(next.length);
      return next;
    });
  const popRef = useRef(popScreen);
  popRef.current = popScreen;
  const exitArmed = useRef(0);

  const nav: Nav = useMemo(
    () => ({
      tab,
      section,
      setTab: (t, sec) =>
        leave(() => {
          setStack([]);
          scrolls.current.length = 0;
          setTab(t);
          if (isSectionTab(t)) setSection(t);
          else if (sec) setSection(sec);
        }),
      push: (s) => leave(() => pushScreen(s)),
      pop: () => leave(() => popScreen()),
      toast,
    }),
    [tab, section, toast, leave],
  );

  // Android back button: one thing per press. The scanner, then the top sheet or shopping mode,
  // then the top screen, then setup's own steps (useBackHandler), then Home, then leave.
  const sayRef = useRef(toast);
  sayRef.current = toast;
  const stateRef = useRef({ stack, tab });
  stateRef.current = { stack, tab };
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = CapApp.addListener('backButton', () => {
      const { stack: st, tab: t } = stateRef.current;
      if (document.querySelector('.scanner')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      } else if (closeTopLayer()) return;
      else if (st.length) leave(() => popRef.current());
      else if (runBackHandlers()) return;
      else if (t !== 'home') leave(() => setTab('home'));
      // 0.9.8: leaving the app takes a second press on Home, so a stray press never throws you out.
      else if (Date.now() - exitArmed.current < 2500) CapApp.exitApp();
      else {
        exitArmed.current = Date.now();
        sayRef.current("Press back again to leave Restock");
      }
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
      // 0.9.8: a notification opens what it's about (PriceChecker, notify.ts, cardReminders.ts).
      else if (a.action?.startsWith('item:')) {
        const groupId = a.action.slice(5);
        nav.setTab('home');
        if (groupId) setStack([{ name: 'item', groupId }]);
      } else if (a.action === 'catalogue') {
        nav.setTab('home');
        setStack([{ name: 'mycatalogue' }]);
      } else if (a.action === 'daily') nav.setTab('pantry');
      else if (a.action === 'cards') setStack([{ name: 'cards' }]);
      else if (a.action === 'sync') setStack([{ name: 'settings' }, { name: 'sync' }]);
      else if (a.action === 'updates') setStack([{ name: 'settings' }]);
      else if (a.action === 'scan') {
        const out = await scanBarcode();
        if (out.ok) setStack((st) => [...st, { name: 'add', barcode: out.code }]);
      }
    };
    void RestockNative.takeLaunchAction()
      .then(run)
      .catch(() => undefined);
    const sub = RestockNative.addListener('launchAction', (e) => void run(e));
    // 0.9.8: reminders the app schedules itself (catalogue day, daily check, gift cards) say where to go too.
    const local = LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
      const action = (e.notification.extra as { action?: unknown } | undefined)?.action;
      if (typeof action === 'string') void run({ action });
    });
    return () => {
      void sub.then((h) => h.remove());
      void local.then((h) => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded]);
  // Tidy away prices older than the history setting, once per launch.
  useEffect(() => {
    // On a Restock server the web keeps the whole history (the phones tidy their own).
    if (!onboarded || serverMode) return;
    void getSettings()
      .then((s) => pruneHistory(s.historyWeeks))
      .catch((e) => console.error('history tidy-up failed', e));
  }, [onboarded]);
  useEffect(() => {
    if (!onboarded || !Capacitor.isNativePlatform()) return;
    const maybeCheck = async () => {
      const s = await getSettings();
      // 0.9.6: checks run at a set time of day (default 5:00 am). If that time passed while the phone
      // was off, check now, once. A check made by hand in between never moves the schedule.
      const { due } = await syncBackgroundSchedule(s).catch((e) => {
        console.error('background schedule failed', e);
        return { due: false };
      });
      const recent = !!s.lastCheck && Date.now() - Date.parse(s.lastCheck) < 30 * 60_000;
      if (!s.lastCheck || (due && !recent)) {
        const r = await checkPrices(undefined, { slot: due });
        if (r.updated) toast(`Updated ${r.updated} price${r.updated === 1 ? '' : 's'}`);
      }
    };
    void maybeCheck().catch((e) => console.error('price check failed', e));
    // Kept separate so a problem with reminders can't stop background price checks, or the reverse.
    void getSettings().then((s) => {
      scheduleReminders(s).catch((e) => console.error('reminders failed', e));
      RestockNative.scheduleRecalls({ enabled: s.recalls.enabled }).catch((e) => console.error('recall schedule failed', e));
    });
    void maybeAutoBackup().catch((e) => console.error('auto backup failed', e));
    void tidyReceipts().catch((e) => console.error('receipt tidy-up failed', e));
    const stopWidgets = watchWidgets();
    // 0.9.3: the shopping list with Home Assistant, if it's on for this phone (homeAssistant.ts).
    const stopHa = serverMode
      ? () => undefined
      : wireHomeAssistant((fn) => {
          const h = CapApp.addListener('resume', fn);
          return () => void h.then((x) => x.remove());
        });
    const sub = CapApp.addListener('resume', () => {
      // The background worker may have saved new prices while the app was closed.
      refresh();
      void maybeCheck().catch((e) => console.error('price check failed', e));
      void maybeAutoBackup().catch((e) => console.error('auto backup failed', e));
    });
    return () => {
      stopWidgets();
      stopHa();
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
  applyTheme(look ?? settings);

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
              {stack[stack.length - 1].name === 'sync' && <SyncScreen invite={(stack[stack.length - 1] as { invite?: boolean }).invite} />}
              {stack[stack.length - 1].name === 'restockServer' && <RestockServerScreen />}
              {stack[stack.length - 1].name === 'homeAssistant' && <HomeAssistantScreen />}
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
  // On a Restock server there's no Add tab: adding is by shop search, which only phones can do.
  const tabs = ALL_TABS.filter((t) => (!isSectionTab(t.id) || inBar.includes(t.id)) && !(serverMode && t.id === 'add'));
  const shownTab: Tab = isSectionTab(tab) && !inBar.includes(tab) ? 'pantry' : tab;
  const addSection: Section = on.includes(section) ? section : 'pantry';

  // The screen opened on top of the tab, if any (the server's own version where it has one).
  const overlay = top ? (
    (serverMode && serverUi.current?.screen(top)) || (
      <>
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
        {top.name === 'sync' && <SyncScreen invite={top.invite} />}
        {top.name === 'restockServer' && <RestockServerScreen />}
        {top.name === 'homeAssistant' && <HomeAssistantScreen />}
        {top.name === 'household' && <HouseholdScreen />}
        {top.name === 'setup' && <SetupScreen />}
        {top.name === 'diagnostics' && <DiagnosticsScreen />}
        {top.name === 'specials' && <SpecialsScreen />}
        {top.name === 'receipts' && <ReceiptsScreen />}
        {top.name === 'receipt' && <ReceiptScreen key={top.id ?? 'new'} id={top.id} />}
        {top.name === 'recalls' && <RecallsScreen />}
        {top.name === 'soon' && <SoonScreen id={top.id} />}
      </>
    )
  ) : undefined;
  // 0.9.1: in the layer on <body>, so the scanner, the toast and its Undo, and what screen readers
  // hear still work while a sheet shuts the app off (components.tsx Sheet).
  const layers = createPortal(
    <>
      <ScannerHost />
      <Announcer text={toastMsg && toastUndo ? `${toastMsg}. Undo button available.` : toastMsg} />
      {toastMsg && (
        <div
          ref={toastRef}
          className={`toast${toastUndo ? ' has-undo' : ''}`}
          // 0.9.5 (undo): waits while a finger or the keyboard is on it.
          onPointerEnter={() => holdToast(true)}
          onPointerDown={() => holdToast(true)}
          onPointerLeave={() => holdToast(false)}
          onPointerUp={(e) => e.pointerType !== 'mouse' && holdToast(false)}
          onFocus={() => holdToast(true)}
          onBlur={() => holdToast(false)}
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
              aria-label={`Undo: ${toastMsg}`}
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
  );

  // 0.9.3: a Restock server's web app in a wide window: a sidebar and wide pages (server-mode/ui/Desktop.tsx).
  if (serverMode && desk && serverUi.current?.Desktop) {
    const Desktop = serverUi.current.Desktop;
    return (
      <NavContext.Provider value={nav}>
        <Desktop tabs={tabs.map((t) => t.id)} tab={shownTab} stack={stack} overlay={overlay} />
        <ConfirmHost />
        {layers}
      </NavContext.Provider>
    );
  }

  return (
    <NavContext.Provider value={nav}>
      <div className="app">
        {/* Covers the status bar, so pages don't scroll up underneath the clock and battery. */}
        <div className="status-shade" aria-hidden />
        {serverMode && serverUi.current && <serverUi.current.Strip />}
        {shownTab === 'home' && <HomeScreen />}
        {isSectionTab(shownTab) && <PantryScreen key={shownTab} section={shownTab} />}
        {shownTab === 'add' && (serverMode && serverUi.current ? <serverUi.current.Tab /> : <AddScreen key={`add-tab-${addSection}`} section={addSection} />)}
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

        {top && <div className="overlay">{overlay}</div>}

        <TourHost />
        <ConfirmHost />
        {layers}
      </div>
    </NavContext.Provider>
  );
}
