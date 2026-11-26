// 0.13.1: inventory on the screen (lib/inventory.ts has the rules). The little "Have: 14" box on a
// tab's rows, the sheet that changes an amount, the Inventory page a tab's Inventory button opens,
// and the Settings page. The phone, the iPhone web app and the web page all use these.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../lib/confirm';
import { allCategories, allGroups, cachedSettings, getProduct, openEntryForGroup } from '../lib/db';
import {
  haveLabel,
  haveState,
  haveText,
  INVENTORY_SECTIONS,
  loadInventory,
  NO_INVENTORY,
  ranLow,
  ranLowTitle,
  roughParts,
  saveHave,
  saveInventorySettings,
  setInventoryTab,
  stepHave,
  UNIT_LABEL,
  UNIT_STEP,
  UNITS,
  type Have,
  type HaveMode,
  type HaveUnit,
  type Inventory,
} from '../lib/inventory';
import { addGroupToList } from '../lib/listActions';
import { act } from '../lib/undo';
import { useLive, useSettings } from '../lib/useLive';
import { SECTION_NAMES, type Section } from '../shops';
import type { Group, Product } from '../types';
import { Icon, SearchField, Sheet, TopBar } from './components';
import { useLeaveGuard } from './leaveGuard';
import { useNav } from './nav';

/** The household's inventory, read again whenever something changes. */
export const useInventory = (): Inventory => useLive(loadInventory, []) ?? NO_INVENTORY;

/** "your pantry", "Baby". */
const tabWords = (s: Section) => (s === 'pantry' ? 'your pantry' : SECTION_NAMES[s]);
const INVENTORY_ABOUT =
  'Keep track of how much you have at home. Count things by number, by weight or volume, or roughly (a quarter, half or three quarters of a pack). Ticking something off while you shop adds it, and Restock can tell you when you are running low.';

type HaveGroup = Pick<Group, 'id' | 'name' | 'section' | 'categoryId'>;

/**
 * A new amount, saved with an Undo. When that takes it to "running low" or "out" and it isn't on the
 * shopping list yet: on the list it goes by itself (when that's switched on), or Restock asks.
 */
async function changeHave(group: HaveGroup, before: Have | undefined, next: Have | undefined, inv: Pick<Inventory, 'auto'>): Promise<void> {
  await act(next ? `${group.name}: you have ${haveText(next)}` : `${group.name} is no longer counted`, () => saveHave(group.id, next), { merge: `have:${group.id}` });
  const how = next ? ranLow(before, next) : undefined;
  if (!how || (await openEntryForGroup(group.id))) return;
  const add = (said: string) =>
    act(
      (ok: boolean) => (ok ? said : null),
      () => addGroupToList(group as Group),
    );
  if (inv.auto) return void (await add(`${ranLowTitle(group.name, how)}: added to your shopping list`));
  const yes = await confirmAction(ranLowTitle(group.name, how), { detail: 'Put it on your shopping list?', action: 'Add to list' });
  if (yes) await add(`${group.name} added to your shopping list`);
}

/** The little box on a row: "Have: 14". Tap it to change the amount. */
export function HaveChip({ name, have, onEdit, bare }: { name: string; have: Have | undefined; onEdit: () => void; /** The Inventory page: just the amount ("14"), as the row's heading says what it is. */ bare?: boolean }) {
  const state = haveState(have);
  const text = !have ? 'How many?' : bare ? haveLabel(have).replace(/^Have: /, '') : haveLabel(have);
  return (
    <button
      type="button"
      className={`inv-have${!have ? ' unset' : state !== 'ok' ? ` ${state}` : ''}`}
      aria-label={have ? `${name}: you have ${haveLabel(have).replace(/^Have: /, '').replace(' · ', ', ')}. Change it` : `Say how much ${name} you have`}
      onClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
    >
      {text}
    </button>
  );
}

const MODES: { id: HaveMode; label: string }[] = [
  { id: 'count', label: 'Number' },
  { id: 'measure', label: 'Weight or volume' },
  { id: 'rough', label: 'Rough amount' },
];
const COUNT_LOW = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12];
const ROUGH_LOW: [number, string][] = [
  [0, 'Only when it runs out'],
  [0.25, '¼ of a pack'],
  [0.5, '½ a pack'],
  [0.75, '¾ of a pack'],
  [1, '1 pack'],
  [2, '2 packs'],
];
const OPEN: [number, string][] = [
  [0, 'Empty'],
  [0.25, '¼'],
  [0.5, '½'],
  [0.75, '¾'],
  [1, 'Full'],
];
const num = (s: string): number => {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const packWords = (p: Pick<Product, 'qty' | 'qtyUnit' | 'size'> | undefined): string | undefined => {
  if (p?.size?.trim()) return p.size.trim();
  if (!p?.qty || p.qtyUnit === 'ea' || !p.qtyUnit) return undefined;
  return p.qty >= 1000 ? `${p.qty / 1000} ${p.qtyUnit === 'g' ? 'kg' : 'L'}` : `${p.qty} ${p.qtyUnit === 'g' ? 'g' : 'mL'}`;
};

/** "How much flour do you have?": the way it's counted, the amount, and when it's running low. */
export function HaveSheet({ group, have, inv, usualProductId, onClose }: { group: HaveGroup; have: Have | undefined; inv: Pick<Inventory, 'auto'>; usualProductId?: string; onClose: () => void }) {
  const [pack, setPack] = useState<Product>();
  useEffect(() => {
    let on = true;
    if (usualProductId) void getProduct(usualProductId).then((p) => on && setPack(p)).catch(() => undefined);
    return () => {
      on = false;
    };
  }, [usualProductId]);
  const [draft, setDraft] = useState<Have>(have ?? { mode: 'count', amount: 1 });
  const [typed, setTyped] = useState<string>();
  const [lowTyped, setLowTyped] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(have ?? { mode: 'count', amount: 1 }) || !have;
  const setMode = (mode: HaveMode) => {
    if (mode === draft.mode) return;
    setTyped(undefined);
    setLowTyped(undefined);
    // Its own amount comes back when the way it was counted is picked again; otherwise a fresh start.
    if (have?.mode === mode) return setDraft(have);
    const unit: HaveUnit | undefined = mode === 'measure' ? (pack?.qtyUnit === 'ml' ? 'ml' : 'g') : undefined;
    setDraft({ mode, amount: mode === 'measure' ? (pack?.qty && pack.qtyUnit !== 'ea' ? pack.qty : 500) : 1, ...(unit ? { unit } : {}) });
  };
  const step = (dir: -1 | 1) => {
    setTyped(undefined);
    setDraft((d) => stepHave(d, dir));
  };
  const parts = roughParts(draft.amount);
  const setRough = (open: number, unopened: number) => setDraft((d) => ({ ...d, amount: Math.max(0, open + unopened) }));
  const save = async () => {
    setBusy(true);
    try {
      await changeHave(group, have, draft, inv);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const size = packWords(pack);
  return (
    <Sheet title={`How much ${group.name} do you have?`} onClose={onClose} unsaved={!!have && dirty}>
      <div className="field">
        <span id="inv-mode">Count it by</span>
        <div className="inv-modes" role="group" aria-labelledby="inv-mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" aria-pressed={draft.mode === m.id} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {draft.mode !== 'rough' && (
        <div className="inv-big" role="group" aria-label="How much">
          <button type="button" aria-label="Less" disabled={draft.amount <= 0} onClick={() => step(-1)}>
            −
          </button>
          <input
            className="inv-num"
            inputMode={draft.mode === 'count' ? 'numeric' : 'decimal'}
            aria-label={draft.mode === 'count' ? 'How many' : `How much, in ${UNIT_LABEL[draft.unit ?? 'g']}`}
            value={typed ?? String(draft.amount)}
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              setTyped(e.target.value);
              setDraft((d) => ({ ...d, amount: d.mode === 'count' ? Math.round(num(e.target.value)) : num(e.target.value) }));
            }}
            onBlur={() => setTyped(undefined)}
          />
          <button type="button" aria-label="More" onClick={() => step(1)}>
            +
          </button>
        </div>
      )}
      {draft.mode === 'measure' && (
        <>
          <div className="inv-units" role="group" aria-label="Unit">
            {UNITS.map((u) => (
              <button key={u} type="button" aria-pressed={(draft.unit ?? 'g') === u} onClick={() => setDraft((d) => ({ ...d, unit: u, low: undefined }))}>
                {UNIT_LABEL[u]}
              </button>
            ))}
          </div>
          <p className="small" style={{ margin: 0 }}>
            {size ? `The pack you buy is ${size}. ` : ''}Plus and minus move {UNIT_STEP[draft.unit ?? 'g']} {UNIT_LABEL[draft.unit ?? 'g']} at a time, or tap the number to type it.
          </p>
        </>
      )}
      {draft.mode === 'rough' && (
        <>
          <div className="field">
            <span id="inv-open">The open pack</span>
            <div className="inv-frac" role="group" aria-labelledby="inv-open">
              {OPEN.map(([v, label]) => (
                <button key={v} type="button" aria-pressed={parts.open === v} onClick={() => setRough(v, parts.unopened)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span id="inv-unopened">Unopened packs</span>
            <div className="inv-big" role="group" aria-labelledby="inv-unopened">
              <button type="button" aria-label="One fewer unopened pack" disabled={parts.unopened <= 0} onClick={() => setRough(parts.open, parts.unopened - 1)}>
                −
              </button>
              <span className="inv-num" aria-live="polite">
                {parts.unopened}
              </span>
              <button type="button" aria-label="One more unopened pack" onClick={() => setRough(parts.open, parts.unopened + 1)}>
                +
              </button>
            </div>
          </div>
          <p className="small" style={{ margin: 0 }} role="status">
            {draft.amount > 0 ? `You have ${haveText(draft)} of the ${size ? `${size} ` : ''}pack you normally buy.` : 'You have none left.'}
          </p>
        </>
      )}

      <label className="field">
        <span>Tell me it's running low at</span>
        {draft.mode === 'count' && (
          <select className="input" value={String(draft.low ?? 0)} onChange={(e) => setDraft((d) => ({ ...d, low: num(e.target.value) || undefined }))}>
            {[...new Set([...COUNT_LOW, draft.low ?? 0])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Only when it runs out' : `${n} left`}
                </option>
              ))}
          </select>
        )}
        {draft.mode === 'rough' && (
          <select className="input" value={String(draft.low ?? 0)} onChange={(e) => setDraft((d) => ({ ...d, low: num(e.target.value) || undefined }))}>
            {ROUGH_LOW.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}
        {draft.mode === 'measure' && (
          <span className="inv-low-measure">
            <input
              className="input"
              inputMode="decimal"
              placeholder="0"
              aria-label={`Running low at, in ${UNIT_LABEL[draft.unit ?? 'g']}`}
              value={lowTyped ?? (draft.low ? String(draft.low) : '')}
              onChange={(e) => {
                setLowTyped(e.target.value);
                setDraft((d) => ({ ...d, low: num(e.target.value) || undefined }));
              }}
            />
            <span>{UNIT_LABEL[draft.unit ?? 'g']} left (leave empty for only when it runs out)</span>
          </span>
        )}
      </label>

      <div className="two">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
      {have && (
        <button
          type="button"
          className="btn small"
          style={{ alignSelf: 'center' }}
          onClick={async () => {
            await changeHave(group, have, undefined, inv);
            onClose();
          }}
        >
          Stop counting this one
        </button>
      )}
    </Sheet>
  );
}

/** A tab's Inventory button (the navy top, beside Edit). There whether inventory is on or not. */
export function InventoryButton({ section, onOpen }: { section: Section; onOpen: () => void }) {
  return (
    <button className="btn small edit-btn inv-btn" aria-label={`Inventory: how much you have in ${tabWords(section)}`} onClick={onOpen}>
      <Icon name="pencil" size={16} /> Inventory
    </button>
  );
}

type Show = 'all' | 'low' | 'out';

/**
 * What a tab's Inventory button opens. Off for this tab: what inventory is, and one big Turn on.
 * On: everything in the tab by category with how much there is; minus and plus for counted things,
 * a tap on any amount to change it; and Turn off at the bottom (the amounts are kept).
 */
function InventoryBody({ section, back }: { section: Section; /** The web page: a way back to the tab. */ back?: ReactNode }) {
  const live = useLive(loadInventory, []);
  const inv = live ?? NO_INVENTORY;
  const loaded = !!live;
  const groups = useLive(allGroups, []);
  const cats = useLive(allCategories, []);
  const [show, setShow] = useState<Show>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Group>();
  const on = inv.tabs.has(section);
  const mine = useMemo(() => (groups ?? []).filter((g) => (g.section ?? 'pantry') === section).sort((a, b) => a.name.localeCompare(b.name)), [groups, section]);
  const name = section === 'pantry' ? 'Pantry' : SECTION_NAMES[section];
  if (!loaded || !groups) return <>{back}</>;
  if (!on)
    return (
      <>
        {back}
        <div className="card inv-intro">
          <h2 className="title">Keep an inventory for {name}?</h2>
          <p>{INVENTORY_ABOUT}</p>
          <ul className="small">
            <li>Each item gets a small "Have" box you can tap to change.</li>
            <li>It is shared with your household, like your pantry.</li>
            <li>Nothing else about {tabWords(section)} changes.</li>
          </ul>
          <button className="btn primary block inv-turn-on" onClick={() => void act(`Inventory turned on for ${name}`, () => setInventoryTab(section, true))}>
            Turn on
          </button>
          <p className="small" style={{ margin: 0, textAlign: 'center' }}>
            Can be turned off here or in Settings.
          </p>
        </div>
      </>
    );
  const low = mine.filter((g) => haveState(inv.have.get(g.id)) === 'low');
  const out = mine.filter((g) => haveState(inv.have.get(g.id)) === 'out');
  const typed = q.trim().toLowerCase();
  const shown = (show === 'low' ? low : show === 'out' ? out : mine).filter((g) => !typed || g.name.toLowerCase().includes(typed));
  const tabCats = (cats ?? []).filter((c) => (c.section ?? 'pantry') === section);
  const sections = [
    ...tabCats.map((c) => ({ id: c.id, name: c.name, items: shown.filter((g) => g.categoryId === c.id) })),
    { id: 'none', name: tabCats.length ? 'Other' : name, items: shown.filter((g) => !g.categoryId || !tabCats.some((c) => c.id === g.categoryId)) },
  ].filter((s) => s.items.length);
  return (
    <>
      {back}
      {mine.length > 0 && <SearchField placeholder={`Search ${tabWords(section)}`} aria-label={`Search ${tabWords(section)}`} value={q} onValue={setQ} />}
      {mine.length > 0 && (
        <div className="chips" role="group" aria-label="Show">
          <button className="chip" aria-pressed={show === 'all'} onClick={() => setShow('all')}>
            All {mine.length}
          </button>
          <button className="chip inv-chip low" aria-pressed={show === 'low'} onClick={() => setShow('low')}>
            Running low {low.length}
          </button>
          <button className="chip inv-chip out" aria-pressed={show === 'out'} onClick={() => setShow('out')}>
            Out {out.length}
          </button>
        </div>
      )}
      {mine.length > 0 && (
        <p className="small" style={{ margin: 0 }}>
          Plus and minus change a count straight away. Tap any amount to change it, or how it is counted.
        </p>
      )}
      {!mine.length && (
        <div className="empty">
          <p>Nothing in {tabWords(section)} yet. Add the things you buy, then say how much of each you have.</p>
        </div>
      )}
      {mine.length > 0 && !shown.length && (
        <p className="small" role="status">
          {typed ? 'Nothing matches.' : show === 'low' ? 'Nothing is running low.' : 'Nothing has run out.'}
        </p>
      )}
      {sections.map((s) => (
        <section key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="eyebrow">{s.name}</div>
          <div className="card flush">
            {s.items.map((g) => {
              const h = inv.have.get(g.id);
              const counted = h?.mode === 'count';
              return (
                <div key={g.id} className="inv-row">
                  <span className="inv-row-name">{g.name}</span>
                  <span className="inv-row-have">
                    {counted && (
                      <button type="button" className="inv-step" aria-label={`One fewer ${g.name}`} disabled={h.amount <= 0} onClick={() => void changeHave(g, h, stepHave(h, -1), inv)}>
                        −
                      </button>
                    )}
                    <HaveChip name={g.name} have={h} bare onEdit={() => setEditing(g)} />
                    {counted && (
                      <button type="button" className="inv-step" aria-label={`One more ${g.name}`} onClick={() => void changeHave(g, h, stepHave(h, 1), inv)}>
                        +
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <div className="inv-foot">
        <p className="small" style={{ margin: 0 }}>
          Inventory is on for {name}. Turning it off hides the amounts; they are kept, in case you turn it back on.
        </p>
        <button className="btn block inv-turn-off" onClick={() => void act(`Inventory turned off for ${name}. Your amounts are kept`, () => setInventoryTab(section, false))}>
          Turn off inventory for {name}
        </button>
      </div>
      {editing && <HaveSheet group={editing} have={inv.have.get(editing.id)} inv={inv} usualProductId={editing.usualProductId} onClose={() => setEditing(undefined)} />}
    </>
  );
}

/** The phone's Inventory page for a tab. */
export function InventoryScreen({ section }: { section: Section }) {
  const nav = useNav();
  const name = section === 'pantry' ? 'Pantry' : SECTION_NAMES[section];
  return (
    <div className="screen inv-screen">
      <TopBar
        title={`${name} inventory`}
        right={
          <button className="icon-btn" aria-label="Inventory settings" onClick={() => nav.push({ name: 'inventorySettings' })}>
            <Icon name="settings" size={20} />
          </button>
        }
      />
      <InventoryBody section={section} />
    </div>
  );
}

/** Settings' row: "Off: keep track of how much you have at home", "On for Pantry and Baby". */
export function inventorySummary(inv: Pick<Inventory, 'tabs'>): string {
  const on = INVENTORY_SECTIONS.filter((s) => inv.tabs.has(s)).map((s) => (s === 'pantry' ? 'Pantry' : SECTION_NAMES[s]));
  if (!on.length) return 'Off: keep track of how much you have at home';
  return `On for ${on.length > 1 ? `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]}` : on[0]}`;
}

/** The tabs there are to keep an inventory for: Pantry, and each tab you made that's switched on. */
export const inventoryTabs = (s: { sections?: Partial<Record<string, boolean>> } | undefined): Section[] =>
  INVENTORY_SECTIONS.filter((x) => x === 'pantry' || !!s?.sections?.[x]);

/**
 * Settings → Inventory: a switch for Pantry and for each tab you made (none on to start with), and
 * what happens when something runs out. Nothing changes until Save settings.
 */
function InventorySettingsBody({ onSaved }: { onSaved?: () => void }) {
  const live = useLive(loadInventory, []);
  const inv = live ?? NO_INVENTORY;
  const loaded = !!live;
  const settings = useSettings() ?? cachedSettings();
  const groups = useLive(allGroups, []);
  const [draft, setDraft] = useState<{ tabs: Section[]; auto: boolean; tick: boolean }>();
  const saved = { tabs: [...inv.tabs].sort(), auto: inv.auto, tick: inv.tick };
  const d = draft ?? saved;
  const dirty = !!draft && JSON.stringify({ ...draft, tabs: [...draft.tabs].sort() }) !== JSON.stringify(saved);
  useLeaveGuard(dirty, 'changing your inventory settings');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const count = (s: Section) => (groups ?? []).filter((g) => (g.section ?? 'pantry') === s).length;
  const toggleTab = (s: Section, on: boolean) => {
    setDone(false);
    setDraft({ ...d, tabs: on ? [...new Set([...d.tabs, s])] : d.tabs.filter((x) => x !== s) });
  };
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await act('Inventory settings saved', () => saveInventorySettings(d));
      setDraft(undefined);
      setDone(true);
      onSaved?.();
    } finally {
      setBusy(false);
    }
  };
  const sw = (key: string, title: string, about: string, on: boolean, change: (on: boolean) => void) => (
    <label className="check" key={key}>
      <input className="switch" type="checkbox" checked={on} onChange={(e) => change(e.target.checked)} />
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <span className="title" style={{ fontSize: 15 }}>
          {title}
        </span>
        <span className="small">{about}</span>
      </span>
    </label>
  );
  if (!loaded) return null;
  return (
    <>
      <p className="small" style={{ margin: 0 }}>
        {INVENTORY_ABOUT} It is off unless you turn it on, tab by tab, and it is shared with your household.
      </p>
      <div className="eyebrow">Keep an inventory for</div>
      <div className="card flush">
        {inventoryTabs(settings).map((s) => {
          const n = count(s);
          return sw(s, s === 'pantry' ? 'Pantry' : SECTION_NAMES[s], `${s === 'pantry' ? '' : 'A tab you made · '}${n} item${n === 1 ? '' : 's'}`, d.tabs.includes(s), (on) => toggleTab(s, on));
        })}
      </div>
      <div className="eyebrow">Running out</div>
      <div className="card flush">
        {sw('auto', 'Add to my shopping list automatically', 'When something runs out or gets low. If this is off, Restock asks you first.', d.auto, (on) => {
          setDone(false);
          setDraft({ ...d, auto: on });
        })}
        {sw('tick', 'Count what I tick off while shopping', 'Ticking an item on your shopping list adds what you bought to what you have.', d.tick, (on) => {
          setDone(false);
          setDraft({ ...d, tick: on });
        })}
      </div>
      <div className={`save-bar inv-save${dirty ? ' dirty' : ''}`}>
        <span className="save-bar-text" role="status" aria-live="polite">
          {dirty ? 'Unsaved changes' : done ? 'Saved' : 'No changes to save'}
        </span>
        <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
          Save settings
        </button>
      </div>
    </>
  );
}

export function InventorySettingsScreen() {
  return (
    <div className="screen inv-screen">
      <TopBar title="Inventory" />
      <InventorySettingsBody />
    </div>
  );
}
