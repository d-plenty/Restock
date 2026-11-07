import { activeSections, chainName } from '../shops';
import { allGroups, allListEntries, getSettings } from './db';
import { onChange } from './live';
import { loadRecommendations } from './recs';
import { RestockNative } from './sql/native';
import { money } from './units';
import { isNative } from '../stores/http';
import type { Settings } from '../types';

// What the home screen widgets show. Android draws them (Widgets.java); the app hands over the
// words each time something changes, a moment later so a burst of changes is one update.

export interface WidgetData {
  deals: { text: string; extra?: string }[];
  list: { text: string; extra?: string }[];
  listCount: number;
  receipts: boolean;
  dark: boolean;
  updated: string;
  look: Settings['widgets'];
}

export async function widgetData(): Promise<WidgetData> {
  const [s, recs, entries, groups] = await Promise.all([getSettings(), loadRecommendations(), allListEntries(), allGroups()]);
  const on = activeSections(s);
  const deals = recs
    .filter((r) => on.includes(r.group.section ?? 'pantry') && (r.action === 'buy' || r.action === 'alt'))
    .sort((a, b) => (b.saving ?? 0) - (a.saving ?? 0))
    .slice(0, 8)
    .map((r) => {
      const d = (r.action === 'alt' ? r.alt : r.best)!;
      return { text: r.group.name, extra: d ? `${money(d.price)} ${chainName(d.product.chain)}` : undefined };
    });
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const open = entries.filter((e) => !e.checked);
  const list = open.slice(0, 8).map((e) => ({
    text: `${(e.qty ?? 1) > 1 ? `${e.qty} × ` : ''}${(e.groupId && names.get(e.groupId)) || e.text}`,
  }));
  const dark =
    s.theme === 'dark' || (s.theme === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches);
  return {
    deals,
    list,
    listCount: open.length,
    receipts: s.receipts.enabled,
    dark,
    updated: new Date().toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    look: s.widgets,
  };
}

let timer: ReturnType<typeof setTimeout> | undefined;

export function pushWidgetsSoon(delay = 1500): void {
  if (!isNative()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void widgetData()
      .then((d) => RestockNative.updateWidgets({ data: JSON.stringify(d) }))
      .catch((e) => console.error('widget update failed', e));
  }, delay);
}

/** Keep the widgets up to date while the app is running. */
export function watchWidgets(): () => void {
  pushWidgetsSoon(0);
  return onChange(() => pushWidgetsSoon());
}
