import { useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import {
  addCategory as addCategoryRow,
  allCategories,
  deleteCategory,
  getSettings,
  renameCategory,
  swapCategories,
  updateSettings,
} from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';
import { activeSections, SECTION_NAMES, type Section } from '../../shops';

export function HouseholdScreen() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const allCats = useLive(allCategories, []);
  const [newCat, setNewCat] = useState('');
  const [section, setSection] = useState<Section>('pantry');
  if (!settings || !allCats) return <div className="screen" />;
  const sectionsOn = activeSections(settings);
  const categories = allCats.filter((c) => c.section === section);

  const move = async (index: number, dir: -1 | 1) => {
    const a = categories[index];
    const b = categories[index + dir];
    if (!a || !b) return;
    await swapCategories(a, b);
  };

  const addCategory = async () => {
    const name = newCat.trim();
    if (!name) return;
    await addCategoryRow(name, section);
    setNewCat('');
  };

  const remove = async (id: string, name: string) => {
    const ok = await confirmAction(`Delete the "${name}" category?`, { detail: 'Items in it move to "Other".', action: 'Delete category' });
    if (!ok) return;
    await deleteCategory(id);
  };

  return (
    <div className="screen">
      <TopBar title="Household" />

      <label className="field">
        <span>Household name</span>
        <input
          className="input"
          defaultValue={settings.household.name}
          onBlur={(e) => updateSettings({ household: { name: e.target.value.trim() || 'Our house' } })}
        />
      </label>
      <p className="small">Made for you automatically. Rename it any time.</p>

      <div className="eyebrow">Members</div>
      <div className="card flush">
        <div className="row">
          <span
            className="swatch"
            style={{
              background: 'var(--green-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              color: 'var(--green-ink)',
              fontSize: 13,
            }}
          >
            Y
          </span>
          <span className="grow">
            <span className="title">You</span>
            <span className="small">Owner · this phone</span>
          </span>
        </div>
        <button className="row" onClick={() => nav.toast('Invites need the sync server, which comes in a later beta.')}>
          <span style={{ color: 'var(--blue)' }}>
            <Icon name="plus" />
          </span>
          <span className="grow">
            <span className="title" style={{ color: 'var(--blue)' }}>
              Invite with a QR code
            </span>
            <span className="small">Coming with the sync server</span>
          </span>
        </button>
      </div>
      <p className="small">Once sync is on, the pantry and list are shared. Loyalty cards and alert settings stay on each phone.</p>

      <div className="eyebrow">Categories</div>
      {sectionsOn.length > 1 && (
        <div className="seg" role="tablist" aria-label="Which tab's categories">
          {sectionsOn.map((sec) => (
            <button key={sec} role="tab" aria-selected={sec === section} className={sec === section ? 'on' : ''} onClick={() => setSection(sec)}>
              <Icon name={sec} size={17} /> {SECTION_NAMES[sec]}
            </button>
          ))}
        </div>
      )}
      <div className="card flush">
        {categories.map((c, i) => (
          <div className="row" key={c.id}>
            <input
              className="input"
              style={{ height: 40 }}
              defaultValue={c.name}
              aria-label={`Category ${i + 1} name`}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && renameCategory(c.id, e.target.value.trim())}
            />
            <button
              className="icon-btn"
              style={{ width: 36, height: 36 }}
              aria-label={`Move ${c.name} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
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
      </div>
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void addCategory();
        }}
      >
        <input
          className="input"
          placeholder="New category"
          aria-label="New category name"
          value={newCat}
          onChange={(e) => setNewCat(e.target.value)}
        />
        <button className="btn" type="submit" disabled={!newCat.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}
