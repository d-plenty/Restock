import type { Snapshot } from './db';
import { isLocalOnlyShop, LOCAL_ONLY_SHOPS } from '../shops';
import type { Group, ListEntry } from '../types';

// 0.9.6: Costco's prices stay on the phone (lib/costcoNotice.ts says so in the app). This is the one
// place that takes them out of a copy of the phone's data before it leaves: spreadsheets (CSV), the
// backup files the phone writes (a file the person shares, and the automatic ones that go to a
// folder or a Restock server) and the shared price pack. Syncing with other phones and the server
// leaves them out in the sync engine itself (SyncEngine.LOCAL_TAB, server engine tabOf).
// Only a copy kept inside Restock on this phone (the safety copy before a restore) keeps them.

/** The part of a snapshot Costco's records live in. */
type Part = Pick<Snapshot, 'products' | 'prices'> & Partial<Pick<Snapshot, 'groups' | 'list' | 'kv'>>;

/**
 * A copy of the data without Costco: its products and their prices, a Costco pick in an item, a
 * list line for Costco, and this phone's Costco setting. Everything else is as it was.
 */
export function withoutCostco<T extends Part>(s: T): T {
  if (!LOCAL_ONLY_SHOPS.length) return s; // 0.9.7: Costco is an ordinary shop, in every copy like the rest
  const gone = new Set(s.products.filter((p) => isLocalOnlyShop(p.chain)).map((p) => p.id));
  const anyList = !!s.list?.some((e) => isLocalOnlyShop(e.chain) || isLocalOnlyShop(e.product?.chain));
  const settings = s.kv?.find((k) => k.key === 'settings');
  const hasSetting = !!settings && typeof settings.value === 'object' && !!settings.value && 'costco' in (settings.value as object);
  if (!gone.size && !anyList && !hasSetting) return s;
  const keep = (id: string | undefined) => !id || !gone.has(id);
  const out: T = { ...s };
  out.products = s.products.filter((p) => keep(p.id));
  out.prices = s.prices.filter((r) => keep(r.productId));
  if (s.groups)
    out.groups = s.groups.map((g) =>
      [g.usualProductId, ...g.sameProductIds, ...g.altProductIds].some((id) => !keep(id))
        ? {
            ...g,
            usualProductId: keep(g.usualProductId) ? g.usualProductId : undefined,
            sameProductIds: g.sameProductIds.filter(keep),
            altProductIds: g.altProductIds.filter(keep),
          }
        : g,
    );
  if (s.list) out.list = s.list.filter((e) => !isLocalOnlyShop(e.chain) && !isLocalOnlyShop(e.product?.chain));
  if (s.kv)
    out.kv = s.kv.map((k) => {
      if (k.key !== 'settings' || !k.value || typeof k.value !== 'object') return k;
      const { costco: _gone, ...rest } = k.value as Record<string, unknown>;
      return { key: k.key, value: rest };
    });
  return out;
}

// ---------- 0.9.6 (review H1): a shopping list line never has Costco as its shop ----------

/** What the person is told when a Costco find goes on the list without its shop, price and product. */
export const COSTCO_LIST_NOTE = 'Costco prices stay on this phone, so the line is added as Any shop.';

/** A list line (or the change to one) at Costco, or with a Costco product behind it. */
export const isCostcoListLine = (e: Partial<Pick<ListEntry, 'chain' | 'product'>>): boolean => isLocalOnlyShop(e.chain) || isLocalOnlyShop(e.product?.chain);

/**
 * The line as it may be saved: a list line is shared with the household and the server, so a Costco
 * one goes on as "Any shop" with its words, without Costco's shop, price or product. Everything
 * that adds or changes a line goes through this (db.ts insertEntryOp and updateEntryOp).
 */
export function listLineWithoutCostco<T extends Partial<ListEntry>>(e: T): T {
  if (!isCostcoListLine(e)) return e;
  const out: T = { ...e };
  if ('chain' in e) out.chain = undefined;
  if ('price' in e) out.price = undefined;
  if ('product' in e) out.product = undefined;
  return out;
}

// ---------- 0.9.6 (review L5): this phone's own Costco data stays across a restore ----------

type Picks = Pick<Group, 'id' | 'usualProductId' | 'sameProductIds' | 'altProductIds'>;

/** This phone's Costco products, their prices, which items pick them, and its Costco setting. */
export interface CostcoHere {
  products: Snapshot['products'];
  prices: Snapshot['prices'];
  groups: Picks[];
  setting?: unknown;
}

const settingOf = (kv: Snapshot['kv'] | undefined): unknown => {
  const v = kv?.find((k) => k.key === 'settings')?.value;
  return v && typeof v === 'object' ? (v as { costco?: unknown }).costco : undefined;
};

/** The Costco part of this phone's data (db.ts snapshot), to put back after a restore. */
export function costcoOf(s: Pick<Snapshot, 'products' | 'prices' | 'groups' | 'kv'>): CostcoHere {
  const ids = new Set(s.products.filter((p) => isLocalOnlyShop(p.chain)).map((p) => p.id));
  return {
    products: s.products.filter((p) => ids.has(p.id)),
    prices: s.prices.filter((r) => ids.has(r.productId)),
    groups: s.groups
      .filter((g) => [g.usualProductId, ...(g.sameProductIds ?? []), ...(g.altProductIds ?? [])].some((id) => !!id && ids.has(id)))
      .map((g) => ({ id: g.id, usualProductId: g.usualProductId, sameProductIds: g.sameProductIds ?? [], altProductIds: g.altProductIds ?? [] })),
    setting: settingOf(s.kv),
  };
}

/**
 * A backup to restore, with this phone's own Costco data put back in (backup files never have it,
 * so restoring one would otherwise delete it). A copy that has Costco data of its own (the safety
 * copy kept inside Restock) is restored as it is. Costco picks go back on the items the backup has;
 * a Costco product no item in the backup picks is left out. "Erase everything" is not a restore:
 * it still removes everything.
 */
export function withCostcoKept<T extends Snapshot>(backup: T, here: CostcoHere): T {
  if (!LOCAL_ONLY_SHOPS.length) return backup; // 0.9.7: backups have Costco's data like the rest
  if (backup.products.some((p) => isLocalOnlyShop(p.chain)) || settingOf(backup.kv) !== undefined) return backup;
  if (!here.products.length && here.setting === undefined) return backup;
  const mine = new Map(here.groups.map((g) => [g.id, g]));
  const costco = new Set(here.products.map((p) => p.id));
  const used = new Set<string>();
  const groups = backup.groups.map((g) => {
    const m = mine.get(g.id);
    if (!m) return g;
    const add = (list: string[] | undefined, from: string[]) => {
      const out = [...(list ?? [])];
      for (const id of from) if (costco.has(id) && !out.includes(id)) out.push(id);
      return out;
    };
    let usual = g.usualProductId;
    const same = add(g.sameProductIds, m.sameProductIds);
    if (m.usualProductId && costco.has(m.usualProductId)) {
      if (!usual) usual = m.usualProductId;
      else if (usual !== m.usualProductId && !same.includes(m.usualProductId)) same.push(m.usualProductId);
    }
    const alt = add(g.altProductIds, m.altProductIds).filter((id) => id !== usual && !same.includes(id));
    for (const id of [usual, ...same, ...alt]) if (id && costco.has(id)) used.add(id);
    return { ...g, usualProductId: usual, sameProductIds: same, altProductIds: alt };
  });
  const have = new Set(backup.products.map((p) => p.id));
  const out: T = {
    ...backup,
    groups,
    products: [...backup.products, ...here.products.filter((p) => used.has(p.id) && !have.has(p.id))],
    prices: [...backup.prices, ...here.prices.filter((r) => used.has(r.productId) && !have.has(r.productId))],
  };
  if (here.setting !== undefined) {
    const kv = backup.kv.some((k) => k.key === 'settings')
      ? backup.kv.map((k) => (k.key === 'settings' && k.value && typeof k.value === 'object' ? { key: k.key, value: { ...(k.value as object), costco: here.setting } } : k))
      : backup.kv;
    out.kv = kv;
  }
  return out;
}
