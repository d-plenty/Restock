import { useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../lib/db';
import { loadDemo, removeDemo } from '../lib/demo';
import { useLive } from '../lib/useLive';
import type { Settings } from '../types';
import { useNav, type Tab } from './nav';
import { sectionOn } from '../shops';

// The guided tour: a card at the bottom of the screen that walks round the app, highlighting
// each part it talks about. Sample items are added for the tour and taken away when it ends
// (anything you added yourself stays).

interface Step {
  tab: Tab;
  /** What to highlight: a CSS selector, or a button's text. */
  find: string | { text: string };
  title: string;
  text: string;
  when?: (s: Settings) => boolean;
}

const STEPS: Step[] = [
  {
    tab: 'home',
    find: '.banner.green',
    title: 'Your week at a glance',
    text: 'Home shows what is genuinely worth buying this week, and roughly how much you save against usual prices.',
  },
  {
    tab: 'home',
    find: '.tag',
    title: 'Every deal is checked',
    text: 'Tags like GREAT DEAL, WAIT and FAKE SALE come from each item’s price history. Tap any tag to see why.',
  },
  {
    tab: 'pantry',
    find: '.screen .card.flush .row',
    title: 'Your pantry',
    text: 'Everything Restock watches for you. Swipe right to put it on your shopping list, or tap it for its prices at every shop.',
  },
  {
    tab: 'add',
    find: { text: 'Scan a barcode' },
    title: 'Adding things',
    text: 'Scan a barcode or search, tick what you buy at each shop that sells it, and Restock does the rest.',
  },
  {
    tab: 'list',
    find: '.screen h1',
    title: 'Your shopping list',
    text: 'Just this trip. Each line shows the cheapest version and where, and the bottom shows what one shop would cost.',
  },
  {
    tab: 'keg',
    find: '.screen h1',
    title: 'Bottle shops',
    text: 'Drinks live on their own Keg tab, so a search for chips never goes to a bottle shop.',
    // Only when the Keg tab is really there: switched on, a bottle shop picked, and not hidden.
    when: (s) => sectionOn(s, 'keg') && !s.hiddenTabs?.includes('keg'),
  },
  {
    tab: 'home',
    find: '[aria-label="Settings"]',
    title: 'Make it yours',
    text: 'Settings has your shops, colours, alerts, backups and the setup tiles. You can take this tour again from there.',
  },
];

const steps = (s: Settings) => STEPS.filter((x) => !x.when || x.when(s));

export async function startTour() {
  const s = await getSettings();
  let added = false;
  if (!s.demoLoaded) {
    await loadDemo();
    added = true;
  }
  await updateSettings({ tour: { ...s.tour, active: true, step: 0, addedSamples: added || s.tour.addedSamples } });
}

export async function endTour() {
  const s = await getSettings();
  if (s.tour.addedSamples) await removeDemo();
  await updateSettings({ tour: { seen: true, active: false, step: 0, addedSamples: false } });
}

function findTarget(f: Step['find']): Element | null {
  if (typeof f === 'string') return document.querySelector(f);
  return [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(f.text)) ?? null;
}

export function TourHost() {
  const settings = useLive(getSettings, []);
  const nav = useNav();
  const [ready, setReady] = useState(false);
  const active = !!settings?.tour.active;
  const list = settings ? steps(settings) : [];
  const i = Math.min(settings?.tour.step ?? 0, Math.max(0, list.length - 1));
  const step = list[i];

  useEffect(() => {
    if (!active || !step) return;
    nav.setTab(step.tab);
    setReady(false);
    let el: Element | null = null;
    const t = setTimeout(() => {
      el = findTarget(step.find);
      el?.classList.add('tour-hi');
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setReady(true);
    }, 450);
    return () => {
      clearTimeout(t);
      el?.classList.remove('tour-hi');
      document.querySelectorAll('.tour-hi').forEach((e) => e.classList.remove('tour-hi'));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, i, step?.title]);

  if (!active || !step || !settings) return null;
  const go = (n: number) => updateSettings({ tour: { ...settings.tour, step: n } });
  return (
    <div className={`tour-card${ready ? ' in' : ''}`} role="dialog" aria-label={`Tour, step ${i + 1} of ${list.length}`} aria-live="polite">
      <div className="small" style={{ fontWeight: 700, color: 'var(--green)' }}>
        Tour · {i + 1} of {list.length}
      </div>
      <div className="title" style={{ fontSize: 17 }}>
        {step.title}
      </div>
      <p className="small" style={{ margin: 0, color: 'var(--ink-2)' }}>
        {step.text}
      </p>
      <div className="tour-actions">
        <button className="btn small ghost" onClick={() => void endTour().then(() => nav.setTab('home'))}>
          End tour
        </button>
        <span style={{ flex: 1 }} />
        {i > 0 && (
          <button className="btn small" onClick={() => void go(i - 1)}>
            Back
          </button>
        )}
        {i < list.length - 1 ? (
          <button className="btn small primary" onClick={() => void go(i + 1)}>
            Next
          </button>
        ) : (
          <button className="btn small primary" onClick={() => void endTour().then(() => nav.setTab('home'))}>
            Finish
          </button>
        )}
      </div>
      {settings.tour.addedSamples && (
        <p className="small" style={{ margin: 0 }}>
          The sample items go away when the tour ends.
        </p>
      )}
    </div>
  );
}
