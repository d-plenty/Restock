import { loadTrip, reopensTrip } from '../lib/trip';
import { afterScreens, CHECK_AFTER_OPEN_MS, screensReady } from '../lib/screensFirst';
import { watchBusy } from '../lib/speedLog';
import { App as CapApp } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Suspense } from 'react';
import { lazyScreen, preloadScreens } from './lazyScreen';
import { isIos as isIosHere } from '../lib/platform';
import { createPortal } from 'react-dom';
import { openDatabase } from '../lib/boot';
import { wireSync } from '../lib/sync';
import { syncBackgroundSchedule } from '../lib/check';
import { CheckLine, trackCheck } from './refresh';
import { wireKeyboard } from '../lib/keyboard';
import { cachedSettings, getKV, getSettings, pruneHistory, putKV, refresh, updateSettings } from '../lib/db';
import { checkForUpdate, learnChannel, SELF_UPDATE, weeklyCheckDue } from '../lib/updates';
import { version as appVersion } from '../../package.json';
import { setConnectionMode } from '../stores/http';
import { applyTheme, isDark, syncInsets } from '../lib/theme';
import { scheduleReminders } from '../lib/notify';
import { useLive } from '../lib/useLive';
import { Announcer, closeTopLayer, Icon, layerHost, Logo, runBackHandlers, ScreenWaiting } from './components';
import { isMoreTab, isSectionTab, NavContext, type Nav, type Screen, type Tab } from './nav';
import { MoreScreen } from './screens/More';
import { activeSections, type Section } from '../shops';
import { ConfirmHost } from './ConfirmHost';
import { ErrorBoundary } from './ErrorBoundary';
import { ScannerHost } from './Scanner';
import { placeToast } from './toastLift';
import { AddScreen } from './screens/Add';
import { HomeScreen } from './screens/Home';
import { ItemScreen } from './screens/Item';
import { ListScreen } from './screens/List';
import { Onboarding } from './screens/Onboarding';
import { WhatsNewPrompt } from './screens/WhatsNew';
import { NameSheet } from './NameAsk';
import { lessMotion, Opening, openingPlayed } from './Opening';
import { holidayNow } from '../lib/holiday';
import { labelPhone } from '../lib/myName';
import { InventoryScreen, InventorySettingsScreen } from './Inventory';
import { noteSeenVersion, seenVersion, shouldOfferWhatsNew } from '../lib/whatsNew';
import { addShared, nameFromLink, splitShared } from '../lib/shared';
import { takeLensBarcode } from '../lib/lens';
import { leavePendingCustom, pendingCustom } from './screens/CustomSections';
import { okToLeave, unsavedWork } from './leaveGuard';
import { rescueOldScans } from '../lib/scanQueue';
import { scanBarcode } from '../lib/barcode';
import { RestockNative } from '../lib/sql/native';
import { TourHost } from './Tour';
import { maybeAutoBackup } from '../lib/autoBackup';
import { watchWidgets } from '../lib/widgets';
import { tidyReceipts } from '../lib/receipts';
import { PantryScreen } from './screens/Pantry';
// Only ever shown on iPhone and iPad, so it (and the sync engine it brings) is loaded only there.
const WifiSyncScreen = lazyScreen(() => import('./screens/WifiSync').then((m) => m.WifiSyncScreen), { preload: isIosHere() });
// 0.15.0: screens opened now and then load when first opened, so Restock starts quicker. 0.15.2: and
// they're loaded quietly once it has started (lazyScreen.tsx), so none opens on a blank page.
const CardsScreen = lazyScreen(() => import('./screens/Cards').then((m) => m.CardsScreen));
const CataloguesScreen = lazyScreen(() => import('./screens/Catalogues').then((m) => m.CataloguesScreen));
const PermissionsScreen = lazyScreen(() => import('./screens/Permissions').then((m) => m.PermissionsScreen));
const HouseholdScreen = lazyScreen(() => import('./screens/Household').then((m) => m.HouseholdScreen));
const CategoriesScreen = lazyScreen(() => import('./screens/Categories').then((m) => m.CategoriesScreen));
const PicksScreen = lazyScreen(() => import('./screens/Picks').then((m) => m.PicksScreen));
const SetupScreen = lazyScreen(() => import('./screens/Setup').then((m) => m.SetupScreen));
const ScannedScreen = lazyScreen(() => import('./screens/Scanned').then((m) => m.ScannedScreen));
const DiagnosticsScreen = lazyScreen(() => import('./screens/Diagnostics').then((m) => m.DiagnosticsScreen));
const ShopCatalogueScreen = lazyScreen(() => import('./screens/ShopCatalogue').then((m) => m.ShopCatalogueScreen));
const RecallsScreen = lazyScreen(() => import('./screens/Recalls').then((m) => m.RecallsScreen));
const SoonScreen = lazyScreen(() => import('./screens/Soon').then((m) => m.SoonScreen));
const SettingsScreen = lazyScreen(() => import('./screens/Settings').then((m) => m.SettingsScreen));
const FeedbackScreen = lazyScreen(() => import('./screens/Feedback').then((m) => m.FeedbackScreen));
const StoresScreen = lazyScreen(() => import('./screens/Stores').then((m) => m.StoresScreen));
const SyncScreen = lazyScreen(() => import('./screens/Sync').then((m) => m.SyncScreen));
const RestockServerScreen = lazyScreen(() => import('./screens/RestockServer').then((m) => m.RestockServerScreen));
const HomeAssistantScreen = lazyScreen(() => import('./screens/HomeAssistant').then((m) => m.HomeAssistantScreen));
const ReceiptScreen = lazyScreen(() => import('./screens/Receipts').then((m) => m.ReceiptScreen));
const ReceiptsScreen = lazyScreen(() => import('./screens/Receipts').then((m) => m.ReceiptsScreen));
const WhatsNewScreen = lazyScreen(() => import('./screens/WhatsNew').then((m) => m.WhatsNewScreen));
const IcloudSyncScreen = lazyScreen(() => import('./screens/IcloudSync').then((m) => m.IcloudSyncScreen), { preload: isIosHere() });
import { wireHomeAssistant } from '../lib/homeAssistant';
import { serverMode, serverUi } from '../server-mode/flag';
import { padSide, usePadWide, type PadSide } from './padWide';
import { isIos } from '../lib/platform';
import { onUndo, undo as undoStep, undoneText } from '../lib/undo';
import { canLeave, getSettings as shownSettings, hasUnsaved } from '../lib/settingsDraft';
import { askChoice, askLeave } from '../lib/confirm';

// 0.12.0: Home, Pantry, List and More. Adding is a button on each of them (it was a fifth tab in
// the middle, 0.10.3). Keg, Health, Baby and Pets are in More, so the bar never gets crowded.
const ALL_TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'pantry', label: 'Pantry', icon: 'pantry' },
  { id: 'list', label: 'List', icon: 'cart' },
  { id: 'more', label: 'More', icon: 'moretabs' },
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
  // 0.12.10: closed mid-shop and opened again soon after: straight back to the list, which reopens the trip.
  const [tab, setTab] = useState<Tab>(() => (reopensTrip(loadTrip(), Date.now()) ? 'list' : 'home'));
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

  // 0.12.9: the keyboard opens where the page puts the cursor (lib/keyboard.ts)
  useEffect(() => wireKeyboard(), []);
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
        const msg = `Restock ${told} is out. Tap Update now on Home, or in Settings → About and updates.`;
        if (Capacitor.isNativePlatform())
          await RestockNative.notify({ id: 4390, title: 'A Restock update is ready', body: msg, action: 'updates' }).catch(() => undefined);
        else setToastMsg(msg);
      })();
    }, 4000);
    return () => window.clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    openDatabase()
      // 0.15.1: which version of the app this is (the Google Play and App Store ones don't update themselves).
      .then(() => learnChannel())
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
      // 0.10.7: Accessibility → Messages stay longer: three times as long
      toastLeft.current = (undo ? 5000 : 2800) * (cachedSettings()?.a11y?.slowMessages ? 3 : 1);
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
  // 0.9.5 (undo): every undoable action (undo.ts) offers Undo here.
  useEffect(
    () =>
      onUndo((e) => {
        if (e.kind === 'added')
          toast(e.step.label, async () => {
            const r = await undoStep(e.step.id);
            if (r) toast(undoneText(r));
          });
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
        if (r) toast(undoneText(r));
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast]);

  // 0.9.5 (save): leaving a settings screen with changes not saved asks first (settingsDraft.ts).
  // 0.10.7: and other work under way that isn't saved (leaveGuard.ts): "Leave without saving?"
  const leave = useCallback((go: () => void) => {
    if (hasUnsaved()) return void canLeave(askLeave).then((ok) => ok && go());
    if (unsavedWork()) return void okToLeave().then((ok) => ok && go());
    go();
  }, []);

  // 0.10.11: going back (or to another tab) from a new custom section that isn't saved asks first,
  // and leaving takes it away again. Opening something from its page doesn't ask.
  const leaveBack = useCallback(
    (go: () => void) => {
      if (pendingCustom()) return void leavePendingCustom().then((ok) => ok && go());
      leave(go);
    },
    [leave],
  );

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
  // 0.13.2: an iPad held sideways (ui/padWide.ts): one of More's rows, opened from the side bar.
  const padWide = usePadWide();
  const openFromSide = (name: PadSide) =>
    leaveBack(() => {
      scrolls.current.length = 0;
      setTab('more');
      setStack([{ name } as Screen]);
    });
  const sideAt = padWide && tab === 'more' ? padSide().find((x) => x.screen === stack[0]?.name)?.screen : undefined;
  const popRef = useRef(popScreen);
  popRef.current = popScreen;
  const exitArmed = useRef(0);

  const nav: Nav = useMemo(
    () => ({
      tab,
      section,
      setTab: (t, sec) =>
        // 0.12.0: Add isn't a tab any more: it opens on top of the tab you're on.
        t === 'add'
          ? leave(() => pushScreen({ name: 'add', section: sec }))
          : leaveBack(() => {
            setStack([]);
            scrolls.current.length = 0;
            setTab(t);
            if (isSectionTab(t)) setSection(t);
            else if (sec) setSection(sec);
          }),
      push: (s) => leave(() => pushScreen(s)),
      pop: () => leaveBack(() => popScreen()),
      toast,
    }),
    [tab, section, toast, leave, leaveBack],
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
      else if (st.length) leaveBack(() => popRef.current());
      else if (runBackHandlers()) return;
      // 0.10.3: from Keg, Health, Baby or Pets, back goes to More (where they were opened).
      else if (isMoreTab(t) && t !== 'more') leave(() => setTab('more'));
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
    // The back button is listened for once; it reads the latest through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check prices when the app opens or comes back, if it's been a while.
  const onboarded = settings?.onboarded;
  // 0.12.9: after an update, offer What's new once. A new install is never asked: it notes the
  // version while it's being set up.
  const [whatsNew, setWhatsNew] = useState(false);
  const [nameLater, setNameLater] = useState(false);
  const [opening, setOpening] = useState(() => !openingPlayed());
  const closeWhatsNew = () => {
    noteSeenVersion(appVersion);
    setWhatsNew(false);
  };
  useEffect(() => {
    if (!settings) return;
    if (!settings.onboarded) return noteSeenVersion(appVersion);
    if (shouldOfferWhatsNew(appVersion, seenVersion(), true, !serverMode)) setWhatsNew(true);
    else noteSeenVersion(appVersion);
    // only when setup finishes or the app opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded, !settings]);

  // 0.10.7: barcode-number lines Scan several used to put on the list go back to Scanned barcodes.
  useEffect(() => {
    if (!onboarded) return;
    void rescueOldScans()
      .then((n) => n > 0 && toast(`${n === 1 ? '1 scanned barcode' : `${n} scanned barcodes`} moved off your list. Match them from Add → Scanned barcodes.`))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded]);

  // Something shared to Restock from another app, or an app icon shortcut (Scan, List, Receipt).
  useEffect(() => {
    if (!onboarded || !Capacitor.isNativePlatform()) return;
    const run = async (a: { action?: string; text?: string }) => {
      // nav.setTab also closes any open screens, so the tab asked for is what shows.
      if (a.action === 'share' && a.text) {
        nav.setTab('list');
        toast(await addShared(a.text));
      } else if (a.action === 'search' && a.text) {
        // 0.10.7: "Restock: Search shops": search the words (a name from Google Lens, say), with the
        // barcode Lens was just asked about, so picking a result remembers that barcode.
        const { words, url } = splitShared(a.text);
        // 0.10.8: a sensible length (a whole page of shared text isn't a product name)
        const query = (words || (url ? nameFromLink(url) : undefined))?.slice(0, 120).trim();
        if (query) {
          nav.setTab('home');
          setStack([{ name: 'add', query, barcode: takeLensBarcode() }]);
        }
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
        // 0.12.3: the weekly deals summary opens Home, where each shop's button says how many of your things are on special there (My catalogue is merged into them)
        nav.setTab('home');
        setStack([]);
      } else if (a.action === 'daily') nav.setTab('pantry');
      else if (a.action === 'cards') setStack([{ name: 'cards' }]);
      else if (a.action === 'sync') setStack([{ name: 'settings' }, { name: 'settings', page: 'sync' }, { name: 'sync' }]);
      // 0.18.1: a change to the server's phones (lib/adminNotices.ts) opens the server's page
      else if (a.action === 'serverPhones') setStack([{ name: 'settings' }, { name: 'settings', page: 'sync' }, { name: 'restockServer' }]);
      else if (a.action === 'updates') setStack([{ name: 'settings' }, { name: 'settings', page: 'about' }]);
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
      .then(async (s) => {
        await pruneHistory(s.historyWeeks);
        // 0.11.0: and what searches found, kept as long (or for its own time)
        await import('../lib/seen').then((f) => f.pruneSeen(s));
      })
      .catch((e) => console.error('history tidy-up failed', e));
  }, [onboarded]);
  useEffect(() => {
    if (!onboarded || !Capacitor.isNativePlatform()) return;
    const maybeCheck = async () => {
      // 0.18.1: the screens first, then the catch-up (on an older iPad it held every page up).
      await afterScreens();
      // 0.18.2: on iPhone and iPad (where the check runs in the app itself) a few seconds more, so
      // you can get going first.
      if (isIos()) await new Promise((r) => setTimeout(r, CHECK_AFTER_OPEN_MS));
      let s = await getSettings();
      // 0.11.0: once, on the update from 0.10.x: automatic checks move to Wednesday and Saturday at
      // 4:00 am (settingsCheck.ts works it out; this saves it, so the phone's background job reads it).
      const stored = await getKV<{ checkMoved0110?: boolean; onboarded?: boolean }>('settings');
      if (stored && stored.checkMoved0110 !== true) {
        s = await updateSettings({ checkMoved0110: true, checkDays: s.checkDays, checkTime: s.checkTime, sync: s.sync });
        toast('Prices are now checked on Wednesday and Saturday at 4:00 am. Change it in Settings → Prices and deals.');
      }
      // 0.9.6: checks run at a set time of day (default 5:00 am). If that time passed while the phone
      // was off, check now, once. A check made by hand in between never moves the schedule.
      const { due } = await syncBackgroundSchedule(s).catch((e) => {
        console.error('background schedule failed', e);
        return { due: false };
      });
      const recent = !!s.lastCheck && Date.now() - Date.parse(s.lastCheck) < 30 * 60_000;
      if (!s.lastCheck || (due && !recent)) {
        // 0.11.1: with its progress showing, like a Check now
        const r = await trackCheck({ slot: due });
        if (r.updated) toast(`Updated ${r.updated} price${r.updated === 1 ? '' : 's'}`);
      }
    };
    void maybeCheck().catch((e) => console.error('price check failed', e));
    // Kept separate so a problem with reminders can't stop background price checks, or the reverse.
    void getSettings().then((s) => {
      scheduleReminders(s).catch((e) => console.error('reminders failed', e));
      RestockNative.scheduleRecalls({ enabled: s.recalls.enabled }).catch((e) => console.error('recall schedule failed', e));
    });
    // 0.18.1: these wait for the screens too (lib/screensFirst.ts).
    void afterScreens()
      .then(() => maybeAutoBackup())
      .catch((e) => console.error('auto backup failed', e));
    void afterScreens()
      .then(() => tidyReceipts())
      .catch((e) => console.error('receipt tidy-up failed', e));
    // 0.18.1: an admin phone hears about changes to the server's phones (lib/adminNotices.ts),
    // when Restock opens and each time it comes back to the screen.
    const phonesNow = () => void import('../lib/adminNotices').then((m) => m.checkPhoneChanges()).catch(() => undefined);
    void afterScreens().then(phonesNow);
    // 0.18.2: Diagnostics → Speed notes the moments the screen was too busy to answer a tap.
    watchBusy();
    // 0.15.2: the screens opened now and then are loaded quietly, so none opens on a blank page.
    void preloadScreens().finally(screensReady);
    // 0.16.0: this phone's name in the household follows the person's (after a restore, say).
    void getSettings()
      .then((s) => (s.myName ? labelPhone(s.myName) : undefined))
      .catch(() => undefined);
    // 0.9.13: feedback that couldn't go when it was sent (no connection) goes now.
    void import('../lib/feedback').then((f) => f.sendWaiting()).catch(() => undefined);
    // 0.10.0: Shared prices is one switch, on for every phone. A phone that had sharing off stays off
    // until it's asked, once (the privacy policy says off stays off): Keep sharing turns it on from
    // now, nothing read while it was off goes. Closing the question asks again next time.
    if (!serverMode)
      void (async () => {
        if (await getKV<boolean>('sharedPrices010')) return;
        const s = await getSettings();
        if (s.sharePrices !== 'no' || !s.onboarded) {
          // On (or still in setup, which asks itself): the one switch is simply on.
          await putKV('sharedPrices010', true);
          if (s.sharePrices === 'unasked') await updateSettings({ sharePrices: 'yes', marketData: { ...s.marketData, enabled: true } }, { local: true });
          return;
        }
        const pick = await askChoice(
          'Shared prices',
          "Restock 0.10.0 joins Judge new items from day one and Send prices back into one switch, Shared prices: new items get a fair verdict from day one, and in return your phone shares the shelf prices it reads from the shops. Nothing about you goes. You had sharing off, so it's still off. Turn it on?",
          [
            { id: 'keep', label: 'Turn on shared prices', kind: 'primary' },
            { id: 'off', label: 'Keep it off' },
          ],
        );
        if (!pick) return;
        await putKV('sharedPrices010', true);
        if (pick === 'keep') {
          const { shareFromNow } = await import('../lib/priceShare');
          await shareFromNow();
          await updateSettings({ sharePrices: 'yes', marketData: { ...s.marketData, enabled: true } }, { local: true });
        }
      })().catch(() => undefined);
    // 0.9.14: Your data: ticks made on other phones or in Home Assistant since Restock last looked.
    // 0.18.1: these three once the screens are up (lib/screensFirst.ts).
    if (!serverMode) void afterScreens().then(() => import('../lib/spending')).then(async (f) => {
      await f.noteTicks();
      await f.maybeSendSpending(); // 0.10.0: Share my spending with the server
    }).catch(() => undefined);
    // 0.9.14: Send prices back: what earlier searches and price checks read, if it didn't go yet.
    if (!serverMode) void afterScreens().then(() => import('../lib/priceShare')).then((f) => f.sendPricesNow()).catch(() => undefined);
    // 0.11.0: what searches found also goes to a household's own Restock server (lib/seen.ts)
    if (!serverMode) void afterScreens().then(() => import('../lib/seen')).then((f) => f.sendSeenToServer()).catch(() => undefined);
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
      phonesNow();
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
          {/* 0.16.0: the opening animation plays before the first screen too */}
          {opening && settings && settings.look.opening !== false && <Opening holiday={holidayNow(settings)} look={isDark(settings.theme) ? 'night' : 'day'} still={lessMotion(settings.a11y.motion)} onDone={() => setOpening(false)} />}
          {/* Setup tiles can open these (cards, shop accounts, sync) before setup is finished. */}
          {stack.length > 0 && (
            <div className="overlay">
              <Suspense fallback={<ScreenWaiting />}>
              {stack[stack.length - 1].name === 'stores' && <StoresScreen section={(stack[stack.length - 1] as { section?: Section }).section} />}
              {stack[stack.length - 1].name === 'cards' && <CardsScreen />}
              {stack[stack.length - 1].name === 'sync' &&
                (isIos() ? (
                  <Suspense fallback={<ScreenWaiting />}>
                    <IcloudSyncScreen />
                  </Suspense>
                ) : (
                  <SyncScreen invite={(stack[stack.length - 1] as { invite?: boolean }).invite} />
                ))}
              {stack[stack.length - 1].name === 'restockServer' && <RestockServerScreen code={(stack[stack.length - 1] as { code?: string }).code} />}
              {stack[stack.length - 1].name === 'homeAssistant' && <HomeAssistantScreen />}
              {stack[stack.length - 1].name === 'household' && <HouseholdScreen />}
              {stack[stack.length - 1].name === 'categories' && <CategoriesScreen section={(stack[stack.length - 1] as { section: Section }).section} />}
              {stack[stack.length - 1].name === 'diagnostics' && <DiagnosticsScreen />}
              {stack[stack.length - 1].name === 'soon' && <SoonScreen id={(stack[stack.length - 1] as { id: string }).id} />}
              </Suspense>
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
  const tabs = ALL_TABS;
  // A tab that's off shows Pantry instead (0.10.3: a hidden one still opens, from Add or a link).
  const shownTab: Tab = isSectionTab(tab) && !on.includes(tab) ? 'pantry' : tab;
  const addSection: Section = on.includes(section) ? section : 'pantry';

  // The screen opened on top of the tab, if any (the server's own version where it has one).
  const overlay = top ? (
    (serverMode && serverUi.current?.screen(top)) || (
      <Suspense fallback={<ScreenWaiting />}>
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
            fromScans={top.fromScans}
            toPantry={top.toPantry}
            scan={top.scan}
            preTick={top.preTick}
            overlay
          />
        )}
        {top.name === 'scanned' && <ScannedScreen section={top.section ?? addSection} start={top.start} />}
        {top.name === 'catalogues' && <CataloguesScreen />}
        {/* 0.12.3: My catalogue is merged into each shop's page; an old link to it lands on Your shops */}
        {top.name === 'mycatalogue' && <CataloguesScreen />}
        {top.name === 'permissions' && <PermissionsScreen />}
        {top.name === 'settings' && <SettingsScreen key={top.page ?? 'main'} page={top.page} />}
        {top.name === 'feedback' && <FeedbackScreen />}
        {top.name === 'whatsnew' && <WhatsNewScreen />}
        {top.name === 'picks' && <PicksScreen />}
        {top.name === 'inventory' && <InventoryScreen section={top.section} />}
        {top.name === 'inventorySettings' && <InventorySettingsScreen />}
        {top.name === 'stores' && <StoresScreen section={top.section} />}
        {top.name === 'cards' && <CardsScreen />}
        {/* 0.13.2: on iPhone and iPad, Sync is iCloud sync (syncing with another phone has its own screen there, wifiSync) */}
        {top.name === 'sync' &&
          (isIos() ? (
            <Suspense fallback={<ScreenWaiting />}>
              <IcloudSyncScreen />
            </Suspense>
          ) : (
            <SyncScreen invite={top.invite} />
          ))}
        {top.name === 'wifiSync' && (
          <Suspense fallback={<ScreenWaiting />}>
            <WifiSyncScreen apple={top.apple} />
          </Suspense>
        )}
        {top.name === 'restockServer' && <RestockServerScreen code={top.code} />}
        {top.name === 'homeAssistant' && <HomeAssistantScreen />}
        {top.name === 'household' && <HouseholdScreen />}
        {top.name === 'categories' && <CategoriesScreen section={top.section} />}
        {top.name === 'setup' && <SetupScreen />}
        {top.name === 'diagnostics' && <DiagnosticsScreen />}
        {/* 0.12.2: My specials is each shop's Catalogue now; an old link to it lands on Your shops */}
        {top.name === 'specials' && <CataloguesScreen />}
        {top.name === 'shopcatalogue' && <ShopCatalogueScreen key={top.chain} chain={top.chain} />}
        {top.name === 'receipts' && <ReceiptsScreen />}
        {top.name === 'receipt' && <ReceiptScreen key={top.id ?? 'new'} id={top.id} />}
        {top.name === 'recalls' && <RecallsScreen />}
        {top.name === 'soon' && <SoonScreen id={top.id} />}
      </Suspense>
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

  return (
    <NavContext.Provider value={nav}>
      <div className={`app${padWide ? ' pad-wide' : ''}`}>
        {/* Covers the status bar, so pages don't scroll up underneath the clock and battery. */}
        <div className="status-shade" aria-hidden />
        {serverMode && serverUi.current && <serverUi.current.Strip />}
        {/* 0.12.9: a running sync or price check is one slim line under the clock on every screen (Home shows it in its own top) */}
        {(shownTab !== 'home' || !!top) && <CheckLine />}
        {shownTab === 'home' && <HomeScreen />}
        {isSectionTab(shownTab) && <PantryScreen key={shownTab} section={shownTab} />}
        {shownTab === 'list' && <ListScreen />}
        {shownTab === 'more' && <MoreScreen />}

        <nav className="tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
          {/* 0.13.2, an iPad held sideways: the same tabs down the left side, with More's rows listed under them. */}
          {padWide && (
            <div className="pad-brand" aria-hidden="true">
              <Logo size={38} />
              <span>Restock</span>
            </div>
          )}
          {tabs
            .filter((t) => !padWide || t.id !== 'more')
            .map((t) => (
              <button
                key={t.id}
                className="tab"
                aria-current={(shownTab === t.id && !(padWide && sideAt)) || (t.id === 'more' && isMoreTab(shownTab)) ? 'page' : undefined}
                onClick={() => nav.setTab(t.id)}
              >
                <Icon name={t.icon} />
                {t.label}
              </button>
            ))}
          {padWide && (
            <>
              <span className="pad-rule" aria-hidden="true" />
              {padSide().map((x) => (
                <button key={x.screen} className="tab" aria-current={sideAt === x.screen ? 'page' : undefined} onClick={() => openFromSide(x.screen)}>
                  <Icon name={x.icon} />
                  {x.label}
                </button>
              ))}
            </>
          )}
        </nav>

        {top && <div className={`overlay${sideAt && stack.length === 1 ? ' side-root' : ''}`}>{overlay}</div>}

        <TourHost />
        <ConfirmHost />
        {/* 0.16.0: the opening animation, once each time Restock starts from closed (Opening.tsx) */}
        {opening && settings && settings.look.opening !== false && <Opening holiday={holidayNow(settings)} look={isDark(settings.theme) ? 'night' : 'day'} still={lessMotion(settings.a11y.motion)} onDone={() => setOpening(false)} />}
        {/* 0.16.0: once after updating (a new install asks while setting up): what to call you */}
        {!whatsNew && !nameLater && settings?.onboarded && !settings.nameAsked && <NameSheet onClose={() => setNameLater(true)} />}
        {whatsNew && (
          <WhatsNewPrompt
            onRead={() => {
              closeWhatsNew();
              nav.push({ name: 'whatsnew' });
            }}
            onSkip={closeWhatsNew}
          />
        )}
        {layers}
      </div>
    </NavContext.Provider>
  );
}
