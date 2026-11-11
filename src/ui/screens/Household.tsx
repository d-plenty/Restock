import { useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import { addCategory as addCategoryRow, allCategories, deleteCategory, renameCategory, swapCategories } from '../../lib/db';
// 0.9.5 (save): the household's name waits for Save settings; categories change at once, with Undo.
import { afterSave, getSettings, updateSettings } from '../../lib/settingsDraft';
import { act } from '../../lib/undo';
import { SaveBar, useDraftState, useSettingsDraft } from '../SaveBar';
import { useLive } from '../../lib/useLive';
import { RestockNative } from '../../lib/sql/native';
import { MAX_SYNC_PHONES, syncInfo } from '../../lib/sync';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';
import { activeSections, SECTION_NAMES, type Section } from '../../shops';

export function HouseholdScreen() {
  useSettingsDraft(); // 0.9.5 (save)
  const draft = useDraftState();
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const sync = useLive(syncInfo, []);
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
    await act(`Moved ${a.name} ${dir < 0 ? 'up' : 'down'}`, () => swapCategories(a, b)); // 0.9.5 (undo)
  };

  const addCategory = async () => {
    const name = newCat.trim();
    if (!name) return;
    await act(`Category ${name} added`, () => addCategoryRow(name, section)); // 0.9.5 (undo)
    setNewCat('');
  };

  const remove = async (id: string, name: string) => {
    const ok = await confirmAction(`Delete the "${name}" category?`, { detail: 'Items in it move to "Other". You can undo it straight after.', action: 'Delete category' });
    if (!ok) return;
    await act(`Category ${name} deleted`, () => deleteCategory(id)); // 0.9.5 (undo)
  };

  return (
    <div className="screen">
      <TopBar title="Household" />

      <label className="field">
        <span>Household name</span>
        <input
          key={sync?.paired ? (sync.household ?? '') : `name-${draft.epoch}` /* 0.9.5 (save): starts again after Discard */}
          className="input"
          // With local sync, the household's name is the owner phone's to change (0.8.5); in a server's
          // house (0.9.4), the server's page renames it.
          disabled={!!sync?.paired && !sync.isOwner}
          defaultValue={sync?.paired && sync.household ? sync.household : settings.household.name}
          // 0.9.5 (save): held until Save settings.
          onChange={(e) => {
            const name = e.target.value.trim() || 'Our house';
            void updateSettings({ household: { name } });
            // The owner's rename reaches the household's other phones (local sync), once saved.
            if (sync?.paired && sync.isOwner)
              void afterSave('household-name', () => RestockNative.syncSet({ household: name }).catch(() => undefined));
          }}
        />
      </label>
      <p className="small">
        {sync?.house
          ? "Your server's house. Rename it on the server's page."
          : sync?.paired && !sync.isOwner
            ? `Shared by your household. Only the owner phone${sync.members?.find((m) => m.owner) ? ` (${sync.members.find((m) => m.owner)!.name})` : ''} can rename it.`
            : 'Made for you automatically. Rename it any time.'}
      </p>

      <div className="eyebrow">Phones</div>
      <div className="card flush">
        {(sync?.paired ? (sync.members ?? []).filter((m) => !m.device.startsWith('srv-')) : [{ device: 'me', name: 'This phone', owner: true, me: true }]).map((m) => (
          <div key={m.device} className="row">
            <Icon name="phone" size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                {m.me ? `${m.name === 'This phone' ? 'This phone' : `${m.name} (this phone)`}` : m.name}
              </span>
              <span className="small">{m.owner ? 'Owner' : sync?.house ? 'On the server' : 'Member'}</span>
            </span>
          </div>
        ))}
        <button className="row" onClick={() => nav.push({ name: 'restockServer' })}>
          <Icon name="server" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15, color: 'var(--green)' }}>
              {sync?.server ? (sync.house ? 'Your Restock server' : 'Restock server') : 'Join your Restock server'}
            </span>
            <span className="small">
              {sync?.house
                ? "The server is the house: phones are added and removed on its page."
                : 'Your server is the house: phones join it, at home and away, and you get Restock in a browser.'}
            </span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
        <button className="row" onClick={() => nav.push({ name: 'sync' })}>
          <Icon name="swap" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15 }}>
              {sync?.house || sync?.serverApi === 3
                ? 'Wi-Fi sync (optional)'
                : sync?.paired
                  ? sync.isOwner
                    ? 'Add or remove phones'
                    : 'Phone sharing (local Wi-Fi)'
                  : 'Phone sharing (local Wi-Fi)'}
            </span>
            <span className="small">
              {sync?.house || sync?.serverApi === 3
                ? `Phone to phone on your Wi-Fi, separate from your server. ${sync.wifiSync === true ? 'On.' : 'Off until you set it up.'}`
                : `Phone to phone on your Wi-Fi. No account, and nothing leaves your home. Up to ${MAX_SYNC_PHONES} phones.`}
            </span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      </div>
      <p className="small">
        {sync?.house
          ? 'Each phone picks what it shares with the house (Sync and backups → What this phone shares), and keeps its own look, backups and shop sign-ins.'
          : 'With sync on, the pantry, list, prices, categories and alerts are shared. Each phone keeps its own look, receipts, backups and shop sign-ins.'}
      </p>

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
              style={{ height: 44 }}
              defaultValue={c.name}
              aria-label={`Category ${i + 1} name`}
              onBlur={(e) => {
                const to = e.target.value.trim();
                if (to && to !== c.name) void act(`${c.name} renamed ${to}`, () => renameCategory(c.id, to)); // 0.9.5 (undo)
              }}
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
      <SaveBar />
    </div>
  );
}
