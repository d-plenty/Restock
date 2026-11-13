import { allCategories, allGroups, allListEntries, insertEntryOp, runOps, uid, updateEntryOp } from './db';
import { candidates, parseLine } from './haMatch';
import { getAliases } from './listPicks';
import { act } from './undo';
import { asListSection, LIST_NAMES, listShareTab, SECTIONS, shopOnTab, type ListSection, type Section } from '../shops';
import type { Category, Group, ListEntry } from '../types';
import type { SqlOp } from './sql/driver';

// 0.9.6: "Move to" a shopping list line between Groceries, Keg, Health and General. Only ever when
// someone presses it (never automatic), on the phone and the web, with one Undo.
//
// What a move keeps and what it can't:
// - Always kept: the words, how many, ticked or not, and when it was added.
// - A pantry item belongs to one tab (Groceries, Keg or Health). General has no pantry, so a line
//   linked to an item and moved to General keeps its words only (no longer linked to the item: no
//   price or best shop from it). The sheet says so before the move.
// - Moved to Groceries, Keg or Health, a line becomes that list's item when its words are clearly
//   one item there (the same name, plurals aside, or a saved "Always use this for …"). Otherwise
//   it stays as its words, and the sheet offers "Pick my …" from that list's items.
// - Its shop stays when the shop is one of the new list's (General takes any). Otherwise it goes
//   (to Any shop), and so does what was found at that shop (photo, price). Its aisle category stays
//   when it's one of the new list's.
// - If the item it becomes is on that list already, still to buy, the two become one line with
//   both amounts (as "Pick my …" and adding do).
//
// How it syncs (no new record kind, no new field: a 0.9.5 phone or server takes it like any other
// change to the list):
// - Between Groceries and General, which sync as one (listShareTab): the line itself changes, the
//   same id. Home Assistant's list (Groceries and General together) keeps it paired.
// - Across tabs (to or from Keg or Health): the line is made again on the new list with a new id and
//   the old one is taken off. A phone that doesn't share the new tab simply sees the line go, like
//   any delete, never a stale copy left on the old list (a changed line whose tab changes isn't
//   seen by phones not sharing the new tab: tools/sync-test SyncTest096). Undo takes the new line
//   off and puts the old one back with its own id. Home Assistant's phone takes a line moved off
//   Groceries or General off Home Assistant's list, and one moved onto them adds it, like a line
//   added or removed in Restock; the later rounds don't move anything back (they never change a
//   line's list).

/** What the move sheet needs to know about the lists. */
export interface MoveFacts {
  groups: Group[];
  categories: Category[];
  aliases: Record<string, string>;
  /** Every line on the lists, for "already on that list" and the line as it is now. */
  entries: ListEntry[];
}

export interface MovePlan {
  from: ListSection;
  to: ListSection;
  /** The line as it will be (a new id when it changes tab). */
  line: ListEntry;
  /** Changed where it is (Groceries ↔ General) rather than made again on the new list. */
  inPlace: boolean;
  /** The item it becomes on the new list. */
  item?: Group;
  /** The item it was linked to and isn't any more. */
  unlinked?: Group;
  /** Its shop, gone because it isn't one of the new list's. */
  shopDropped?: string;
  /** An open line for the same item already on the new list: the amounts go together on it. */
  joins?: ListEntry;
  /** Not linked to anything on the new list, and that list has items to pick from ("Pick my …"). */
  canPick: boolean;
}

export async function moveFacts(): Promise<MoveFacts> {
  const [groups, categories, aliases, entries] = await Promise.all([allGroups(), allCategories(), getAliases().catch(() => ({})), allListEntries()]);
  return { groups, categories, aliases, entries };
}

const tabOfGroup = (g: Group | undefined): Section => (g?.section && (SECTIONS as string[]).includes(g.section) ? g.section : 'pantry');

/** Which list a line is on now (List.tsx entrySection: its item's tab, else its own). */
export function listOfLine(e: ListEntry, groups: Group[]): ListSection {
  const g = e.groupId ? groups.find((x) => x.id === e.groupId) : undefined;
  if (g) return tabOfGroup(g);
  return asListSection(e.section);
}

/** Whether a shop is one of a list's (General: any shop; "other", typed by hand, goes anywhere). */
// 0.10.3: a shop picked for that tab fits it too (Woolworths nappies on the Baby list).
export const shopFits = (chain: string, to: ListSection) => to === 'general' || chain === 'other' || shopOnTab(chain, to);

/** What moving `e` to `to` would do, or undefined when it's on that list already. */
export function planMove(e: ListEntry, to: ListSection, f: MoveFacts): MovePlan | undefined {
  const from = listOfLine(e, f.groups);
  if (from === to) return undefined;
  const linkedTo = e.groupId ? f.groups.find((g) => g.id === e.groupId) : undefined;
  const words = linkedTo?.name ?? e.text;
  const inPlace = listShareTab(from) === listShareTab(to);
  const line: ListEntry = {
    id: inPlace ? e.id : uid(),
    text: words,
    qty: Math.max(1, e.qty ?? 1),
    checked: e.checked,
    createdAt: e.createdAt,
    section: to,
  };
  let item: Group | undefined;
  let canPick = false;
  if (to !== 'general') {
    const here = f.groups.filter((g) => tabOfGroup(g) === to);
    const found = candidates(words, here, f.aliases);
    item = found.length === 1 ? here.find((g) => g.id === found[0].id) : undefined;
    canPick = !item && here.length > 0;
  }
  if (item) {
    line.groupId = item.id;
    line.text = item.name;
    // "2 milk" as words: the item, two of them (as Home Assistant's lines are).
    if (!linkedTo && (e.qty ?? 1) <= 1) {
      const said = parseLine(e.text);
      if (said.qty > 1 && said.name.trim()) line.qty = said.qty;
    }
  }
  let shopDropped: string | undefined;
  if (e.chain) {
    if (shopFits(e.chain, to)) {
      line.chain = e.chain;
      if (e.product) line.product = e.product;
      if (e.price !== undefined) line.price = e.price;
    } else shopDropped = e.chain;
  }
  const cat = item?.categoryId ?? (e.categoryId && f.categories.some((c) => c.id === e.categoryId && c.section === to) ? e.categoryId : undefined);
  if (cat && to !== 'general') line.categoryId = cat;
  const joins = item && !e.checked ? f.entries.find((x) => x.id !== e.id && x.groupId === item!.id && !x.checked) : undefined;
  return { from, to, line, inPlace, item, unlinked: linkedTo && linkedTo.id !== item?.id ? linkedTo : undefined, shopDropped, joins, canPick };
}

/** The statements for a move (one write, so the list reloads once and Undo has it all). */
export function moveOps(e: ListEntry, p: MovePlan): SqlOp[] {
  if (p.joins) {
    const op = updateEntryOp(p.joins.id, { qty: Math.max(1, p.joins.qty ?? 1) + p.line.qty! });
    return [...(op ? [op] : []), { sql: 'DELETE FROM list_entries WHERE id = ?', params: [e.id] }];
  }
  if (!p.inPlace) return [insertEntryOp(p.line), { sql: 'DELETE FROM list_entries WHERE id = ?', params: [e.id] }];
  const l = p.line;
  const ops: SqlOp[] = [
    {
      sql: 'UPDATE list_entries SET text = ?, item_id = ?, chain = ?, category_id = ?, price = ?, section = ?, product = ? WHERE id = ?',
      params: [l.text, l.groupId ?? null, l.chain ?? null, l.categoryId ?? null, l.price ?? null, l.section ?? null, l.product ? JSON.stringify(l.product) : null, e.id],
    },
  ];
  // "2 milk" became two of the item: the amount is a change of its own (its clock, for sync).
  if (l.qty !== Math.max(1, e.qty ?? 1)) ops.push(updateEntryOp(e.id, { qty: l.qty })!);
  return ops;
}

export interface Moved {
  plan: MovePlan;
  /** The line's id now (a new one when it changed tab; the line it joined). */
  id: string;
}

/**
 * Moves a line, as it is now (another phone may have changed or deleted it since the sheet
 * opened). Not an action by itself: moveTo and moveAll are.
 */
export async function moveLine(entryId: string, to: ListSection, facts?: MoveFacts): Promise<Moved | undefined> {
  const f = facts ?? (await moveFacts());
  const e = f.entries.find((x) => x.id === entryId);
  if (!e) return undefined;
  const plan = planMove(e, to, f);
  if (!plan) return undefined;
  await runOps(moveOps(e, plan));
  return { plan, id: plan.joins?.id ?? plan.line.id };
}

/** "Ice moved to Keg" (the toast, with Undo). */
export function movedWords(name: string, p: MovePlan): string {
  const list = LIST_NAMES[p.to];
  if (p.joins) return `${name} moved to ${list}, added to the ${p.item!.name} already there`;
  if (p.item && p.item.name !== name) return `${name} moved to ${list} as ${p.item.name}`;
  return `${name} moved to ${list}`;
}

/** One line, as an undoable action. */
export const moveTo = (entryId: string, to: ListSection, name: string) =>
  act(
    (m: Moved | undefined) => (m ? movedWords(name, m.plan) : null),
    () => moveLine(entryId, to),
  );

/** Several lines (Select on the list): one Undo for them all. Answers how many moved. */
export const moveAll = (entryIds: string[], to: ListSection) =>
  act(
    (n: number) => (n ? `${n} moved to ${LIST_NAMES[to]}` : null),
    async () => {
      let n = 0;
      for (const id of entryIds) if (await moveLine(id, to)) n++;
      return n;
    },
  );

/**
 * What the sheet says under each list before the move (plain words, no em dashes): what happens
 * to the item link, the shop and "Pick my …". Empty when nothing changes but the list.
 */
export function moveNote(p: MovePlan, shopName: (c: string) => string): string {
  const bits: string[] = [];
  if (p.to === 'general' && p.unlinked) bits.push(`General has no pantry: it keeps its words only, not linked to ${p.unlinked.name}.`);
  else if (p.item && p.joins) bits.push(`${p.item.name} is on it already: one line, with both amounts.`);
  else if (p.item) bits.push(`Becomes your ${LIST_NAMES[p.to]} item ${p.item.name}.`);
  else if (p.unlinked) bits.push(`Not linked to ${p.unlinked.name} any more.`);
  if (!p.item && p.canPick) bits.push(`Then pick which ${LIST_NAMES[p.to]} item it is, or keep the words.`);
  if (p.shopDropped) bits.push(`${shopName(p.shopDropped)} isn't one of its shops: Any shop.`);
  return bits.join(' ');
}

/** The items "Pick my …" offers after a move to `to` (that list's items). */
export const pickableFor = (to: ListSection, groups: Group[]) => (to === 'general' ? [] : groups.filter((g) => tabOfGroup(g) === to));

/**
 * "Pick my …" after a move: the line becomes that item of the list it's on now (joining a line for
 * the item still to buy, as pickItemFor does). Its own action, with its own Undo.
 */
export async function linkMoved(entryId: string, item: Group): Promise<boolean> {
  const all = await allListEntries();
  const now = all.find((x) => x.id === entryId);
  if (!now) return false;
  const already = all.find((x) => x.id !== now.id && x.groupId === item.id && !x.checked);
  if (already && !now.checked) {
    await runOps([updateEntryOp(already.id, { qty: Math.max(1, already.qty ?? 1) + Math.max(1, now.qty ?? 1) })!, { sql: 'DELETE FROM list_entries WHERE id = ?', params: [now.id] }]);
  } else {
    // Its shop stays if it's one of the item's list's; otherwise it goes, with what was found there.
    const keepShop = !now.chain || shopFits(now.chain, tabOfGroup(item));
    await runOps([
      updateEntryOp(now.id, {
        groupId: item.id,
        text: item.name,
        section: tabOfGroup(item),
        ...(item.categoryId ? { categoryId: item.categoryId } : {}),
        ...(keepShop ? {} : { chain: undefined, price: undefined }),
      })!,
      ...(keepShop ? [] : [{ sql: 'UPDATE list_entries SET product = NULL WHERE id = ?', params: [now.id] }]),
    ]);
  }
  return true;
}

export const pickMoved = (entryId: string, item: Group) => act((ok: boolean) => (ok ? `${item.name} it is` : null), () => linkMoved(entryId, item));
