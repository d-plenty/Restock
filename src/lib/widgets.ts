import { activeSections, chainName, LIST_SECTIONS, listSectionsOn, type ListSection } from '../shops';
import { allGroups, allListEntries, getSettings } from './db';
import { onChange } from './live';
import { loadRecommendations } from './recs';
import { RestockNative } from './sql/native';
import { money } from './units';
import { isNative } from '../stores/http';
import type { Group, ListEntry, Settings } from '../types';

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

/**
 * The list lines the widget shows (0.9.0): only from tabs that are switched on, and in the list's
 * own order, A to Z by name the way the List tab sorts them (Groceries first, then Keg, then Health, then General).
 */
export function widgetList(
  entries: ListEntry[],
  groups: Pick<Group, 'id' | 'name' | 'section'>[],
  settings: Parameters<typeof activeSections>[0],
): { open: ListEntry[]; label: (e: ListEntry) => string } {
  // 0.9.5: and General's, after the others.
  const on = listSectionsOn(settings);
  const byId = new Map(groups.map((g) => [g.id, g]));
  // A line's tab: its pantry item's, or the tab it was added from (List.tsx entrySection).
  const tab = (e: ListEntry): ListSection => {
    const g = e.groupId ? byId.get(e.groupId) : undefined;
    return g ? (g.section ?? 'pantry') : (e.section ?? 'pantry');
  };
  const label = (e: ListEntry) => (e.groupId && byId.get(e.groupId)?.name) || e.text;
  const open = entries
    .filter((e) => !e.checked && on.includes(tab(e)))
    .sort((a, b) => LIST_SECTIONS.indexOf(tab(a)) - LIST_SECTIONS.indexOf(tab(b)) || label(a).localeCompare(label(b), undefined, { sensitivity: 'base' }));
  return { open, label };
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
  const { open, label } = widgetList(entries, groups, s);
  const list = open.slice(0, 8).map((e) => ({
    text: `${(e.qty ?? 1) > 1 ? `${e.qty} × ` : ''}${label(e)}`,
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
