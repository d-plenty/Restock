import { useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import { addCategory as addCategoryRow, allCategories, deleteCategory, renameCategory, swapCategories } from '../../lib/db';
import { act } from '../../lib/undo';
import { useLive } from '../../lib/useLive';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';
import { SECTION_NAMES, type Section } from '../../shops';

// 0.11.3: a tab's categories, on a screen of their own. Until now the only way in was the Household
// screen, reached from a "Rename" button that a phone on a Restock server doesn't have, so those
// phones had no way to add a category. Opened from Settings → Your shops → a tab, and from each
// tab's Edit menu. Changes are saved at once, each with Undo (as on the Household screen).

/** One tab's categories: rename, reorder, delete, add. */
export function CategoryEditor({ section }: { section: Section }) {
  const nav = useNav();
  const allCats = useLive(allCategories, []);
  const [newCat, setNewCat] = useState('');
  if (!allCats) return null;
  const categories = allCats.filter((c) => c.section === section);

  const move = async (index: number, dir: -1 | 1) => {
    const a = categories[index];
    const b = categories[index + dir];
    if (!a || !b) return;
    await act(`Moved ${a.name} ${dir < 0 ? 'up' : 'down'}`, () => swapCategories(a, b));
  };
  const add = async () => {
    const name = newCat.trim();
    if (!name) return;
    // One of that name on this tab already: say so, don't make a second.
    if (categories.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) return nav.toast(`There's already a ${name} category`);
    await act(`Category ${name} added`, () => addCategoryRow(name, section));
    setNewCat('');
  };
  const remove = async (id: string, name: string) => {
    const ok = await confirmAction(`Delete the "${name}" category?`, { detail: 'Items in it move to "Other". You can undo it straight after.', action: 'Delete category' });
    if (!ok) return;
    await act(`Category ${name} deleted`, () => deleteCategory(id));
  };

  return (
    <>
      <div className="card flush">
        {categories.map((c, i) => (
          <div className="row" key={c.id}>
            <input
              className="input"
              style={{ flex: 1, height: 40 }}
              defaultValue={c.name}
              aria-label={`Category ${i + 1} name`}
              onBlur={(e) => {
                const to = e.target.value.trim();
                if (to && to !== c.name) void act(`${c.name} renamed ${to}`, () => renameCategory(c.id, to));
              }}
            />
            <button className="icon-btn" style={{ width: 36, height: 36 }} aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <Icon name="up" size={16} />
            </button>
            <button
              className="icon-btn"
              style={{ width: 36, height: 36 }}
              aria-label={`Move ${c.name} down`}
              disabled={i === categories.length - 1}
              onClick={() => move(i, 1)}
            >
              <Icon name="down" size={16} />
            </button>
            <button className="icon-btn" style={{ width: 36, height: 36 }} aria-label={`Delete ${c.name}`} onClick={() => remove(c.id, c.name)}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        ))}
        {categories.length === 0 && <p className="row small">No categories on this tab yet.</p>}
      </div>
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="input" placeholder="New category" aria-label="New category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
        <button className="btn" type="submit" disabled={!newCat.trim()}>
          Add
        </button>
      </form>
    </>
  );
}

export function CategoriesScreen({ section }: { section: Section }) {
  return (
    <div className="screen">
      <TopBar title={`${SECTION_NAMES[section]} categories`} />
      <p className="small" style={{ margin: 0 }}>
        The groups your {SECTION_NAMES[section]} tab is sorted into. Rename one by typing over it. Changes are saved straight away, and each has
        Undo. Your household's other phones get them when they sync.
      </p>
      <CategoryEditor section={section} />
    </div>
  );
}

const NEW = '__new';

/**
 * 0.11.3: the category box when adding something, with "New category…" at the bottom: type a name,
 * tap Add, and it's made and picked, without leaving what you were adding.
 */
export function CategoryPick({
  section,
  categories,
  value,
  onChange,
  none = 'No category',
}: {
  section: Section;
  categories: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  none?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    // One of the same name on this tab already: pick it, don't make a second.
    const same = categories.find((c) => c.name.trim().toLowerCase() === n.toLowerCase());
    const id = same?.id ?? (await addCategoryRow(n, section));
    onChange(id);
    setName('');
    setAdding(false);
  };
  return (
    <>
      <select
        className="input"
        value={adding ? NEW : value}
        aria-label="Category"
        onChange={(e) => {
          if (e.target.value === NEW) return setAdding(true);
          setAdding(false);
          onChange(e.target.value);
        }}
      >
        <option value="">{none}</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value={NEW}>New category…</option>
      </select>
      {adding && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            autoFocus
            placeholder="New category"
            aria-label="New category name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              }
            }}
          />
          <button type="button" className="btn" disabled={!name.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
      )}
    </>
  );
}
