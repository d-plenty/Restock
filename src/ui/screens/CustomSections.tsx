// 0.10.7: custom sections. Up to eight sections people make themselves: a name, a colour, an icon
// (from Restock's pack, or any emoji) and the shops to compare. Baby and Pets are two of them (they
// keep their ids, so nothing anyone has moves). Made from More → Custom, and edited only here, in
// Settings → the section's page.
import { useState } from 'react';
import { useLive } from '../../lib/useLive';
import { ensureDefaults, getSettings as getSaved, updateSettings as saveNow } from '../../lib/db';
import { updateSettings } from '../../lib/settingsDraft';
import {
  CUSTOM_COLOURS,
  CUSTOM_SECTIONS,
  CUSTOM_SLOTS,
  MAX_CUSTOM,
  PACK_ICON_IDS,
  customDef,
  isEmojiIcon,
  type CustomColour,
  type CustomDef,
  type CustomSection,
} from '../../shops';
import type { Settings } from '../../types';
import { Icon, Sheet } from '../components';
import { useNav } from '../nav';

/** Ready-made starts: a name, a colour and an icon (the shops are picked next). */
export const CUSTOM_PRESETS: { def: CustomDef; about: string; slot?: CustomSection }[] = [
  { def: { name: 'Baby', colour: 'pink', icon: 'pack:bottle' }, about: 'Nappies, wipes and formula', slot: 'baby' },
  { def: { name: 'Pets', colour: 'blue', icon: 'pack:paw' }, about: 'Pet food, litter and treats', slot: 'pets' },
  { def: { name: 'Automotive', colour: 'slate', icon: 'pack:car' }, about: 'Oil, car care and parts' },
  { def: { name: 'Tools', colour: 'orange', icon: 'pack:tools' }, about: 'Hardware and tools' },
  { def: { name: 'Office', colour: 'purple', icon: 'pack:office' }, about: 'Stationery and office supplies' },
];

const COLOUR_NAME: Record<CustomColour, string> = {
  pink: 'Pink',
  blue: 'Blue',
  teal: 'Teal',
  purple: 'Purple',
  orange: 'Orange',
  amber: 'Yellow',
  green: 'Green',
  slate: 'Grey',
};
const ICON_NAME: Record<string, string> = {
  bottle: 'Baby bottle', paw: 'Paw', car: 'Car', tools: 'Spanner and screwdriver', papers: 'Paper stack', office: 'Office',
  plant: 'Plant', roller: 'Paint roller', bulb: 'Light bulb', gift: 'Gift', shirt: 'T-shirt', book: 'Book', gamepad: 'Game controller',
  dumbbell: 'Dumbbell', tent: 'Tent', fishing: 'Fishing rod', couch: 'Couch', phone: 'Phone', spray: 'Spray bottle', scissors: 'Scissors',
  ball: 'Football', coffee: 'Coffee cup', wine: 'Wine glass', star: 'Star',
};

/** The custom sections in use (switched on), in their order. */
export const customsInUse = (s: Settings | undefined): CustomSection[] => CUSTOM_SECTIONS.filter((c) => !!s?.sections?.[c]);

/** A free slot for a new section: a preset's own (Baby, Pets) when it's free, else the first free c1–c6. */
function freeSlot(s: Settings, want?: CustomSection): CustomSection | undefined {
  if (want && !s.sections[want]) return want;
  return [...CUSTOM_SLOTS, 'baby' as const, 'pets' as const].find((c) => !s.sections[c] && !s.customSections?.[c]) ?? [...CUSTOM_SLOTS].find((c) => !s.sections[c]);
}

/** Makes a section (saved straight away) and opens its page in Settings to pick its shops. */
export async function makeCustomSection(def: CustomDef, want?: CustomSection): Promise<CustomSection | undefined> {
  const s = await getSaved();
  if (customsInUse(s).length >= MAX_CUSTOM) return undefined;
  const id = freeSlot(s, want);
  if (!id) return undefined;
  const patch = {
    sections: { ...s.sections, [id]: true },
    customSections: { ...s.customSections, [id]: def },
  };
  await saveNow(patch);
  // 0.10.8: an open settings page agrees, so its Save can't undo this
  await updateSettings(patch);
  await ensureDefaults().catch(() => undefined);
  return id;
}

/** The starts to pick from (and "Your own"): makes the section, then onMade (More, Settings, setup). */
export function CustomStarts({ onMade }: { onMade: (id: CustomSection) => void }) {
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const saved = useLive(getSaved, []);
  // A start that's already one of your sections isn't offered again (Pets twice).
  const inUse = new Set(saved ? customsInUse(saved).map((c) => customDef(saved, c).name.trim().toLowerCase()) : []);
  const presets = CUSTOM_PRESETS.filter((p) => !inUse.has(p.def.name.toLowerCase()) && !(p.slot && saved?.sections?.[p.slot]));
  const make = async (def: CustomDef, slot?: CustomSection) => {
    setBusy(true);
    try {
      const id = await makeCustomSection(def, slot);
      if (!id) return setFull(true);
      onMade(id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {full && (
        <p className="small" role="alert" style={{ margin: 0 }}>
          You have {MAX_CUSTOM} custom sections, the most there can be. Delete one in Settings to make another.
        </p>
      )}
      <div className="card flush">
        {presets.map((p) => (
          <button key={p.def.name} className="row" disabled={busy} onClick={() => void make(p.def, p.slot)}>
            <span className={`custom-mark tile-colour-${p.def.colour}`}>
              <Icon name={p.def.icon} size={22} />
            </span>
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                {p.def.name}
              </span>
              <span className="small">{p.about}</span>
            </span>
            <Icon name="plus" size={18} />
          </button>
        ))}
        <button className="row" disabled={busy} onClick={() => void make({ name: 'My section', colour: 'teal', icon: 'pack:star' })}>
          <span className="custom-mark tile-colour-teal">
            <Icon name="pencil" size={22} />
          </span>
          <span className="grow">
            <span className="title" style={{ fontSize: 15 }}>
              Your own
            </span>
            <span className="small">Name it, pick a colour and an icon</span>
          </span>
          <Icon name="plus" size={18} />
        </button>
      </div>
    </>
  );
}

/** More → Custom (and Settings → Make a custom section): pick a start, then its page in Settings opens. */
export function NewCustomSheet({ onClose }: { onClose: () => void }) {
  const nav = useNav();
  return (
    <Sheet title="Make a custom section" onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        Compare any shops you like: pet shops, tools, automotive, baby things and more. Give it a name, a colour and an icon, then pick its shops.
      </p>
      <CustomStarts
        onMade={(id) => {
          onClose();
          nav.push({ name: 'settings' });
          nav.push({ name: 'stores', section: id });
        }}
      />
    </Sheet>
  );
}

/** The top of a custom section's page in Settings: its name, colour and icon, and Delete. */
export function CustomSectionHead({ settings, section }: { settings: Settings; section: CustomSection }) {
  const nav = useNav();
  const def = customDef(settings, section);
  const [emoji, setEmoji] = useState(def.icon.startsWith('pack:') ? '' : def.icon);
  const [lastName] = useState(def.name.trim() || 'My section');
  const [asking, setAsking] = useState(false);
  const set = (patch: Partial<CustomDef>) => void updateSettings({ customSections: { ...settings.customSections, [section]: { ...def, ...patch } } });
  const nameOk = def.name.trim().length > 0;
  return (
    <>
      <div className="card" style={{ gap: 12 }}>
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={def.name}
            maxLength={30}
            // 0.10.8: no invisible or text-flipping marks (a pasted name can carry them), and an empty
            // name goes back to what it was when you leave the box, instead of saving as "Custom".
            onChange={(e) =>
              set({
                name: e.target.value.replace(/[<>\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ''),
              })
            }
            onBlur={() => {
              if (!def.name.trim()) set({ name: lastName });
            }}
            aria-invalid={!nameOk}
          />
        </label>
        {!nameOk && (
          <p className="small" role="alert" style={{ margin: 0 }}>
            Give it a name (or it goes back to {lastName}).
          </p>
        )}
        <fieldset className="plain-fieldset">
          <legend className="field-label">Colour</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {CUSTOM_COLOURS.map((c) => (
              <button
                key={c}
                type="button"
                className={`colour-swatch more-tile tile-colour-${c}`}
                aria-pressed={def.colour === c}
                aria-label={COLOUR_NAME[c]}
                title={COLOUR_NAME[c]}
                onClick={() => set({ colour: c })}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="plain-fieldset">
          <legend className="field-label">Icon</legend>
          <div className="icon-grid">
            {PACK_ICON_IDS.map((i) => (
              <button
                key={i}
                type="button"
                className="icon-pick"
                aria-pressed={def.icon === `pack:${i}`}
                aria-label={ICON_NAME[i] ?? i}
                title={ICON_NAME[i] ?? i}
                onClick={() => {
                  setEmoji('');
                  set({ icon: `pack:${i}` });
                }}
              >
                <Icon name={`pack:${i}`} size={24} />
              </button>
            ))}
          </div>
          <label className="field" style={{ marginTop: 10 }}>
            <span>Or use an emoji</span>
            <input
              className="input"
              value={emoji}
              placeholder="Tap here, then pick one from your keyboard"
              onChange={(e) => {
                const v = e.target.value.trim();
                setEmoji(v);
                // only kept when it's an emoji (shops.ts isEmojiIcon)
                if (isEmojiIcon(v)) set({ icon: v });
              }}
              aria-invalid={!!emoji && !isEmojiIcon(emoji)}
              aria-describedby="custom-emoji-note"
            />
          </label>
          {emoji && !isEmojiIcon(emoji) && (
            <p className="small" id="custom-emoji-note" role="alert" style={{ margin: 0 }}>
              That isn't an emoji. Pick one (or a few) from your keyboard's emoji page.
            </p>
          )}
        </fieldset>
      </div>
      <button className="btn danger-ghost" onClick={() => setAsking(true)}>
        <Icon name="trash" size={18} /> Delete this section
      </button>
      {asking && (
        <Sheet title={`Delete ${def.name}?`} onClose={() => setAsking(false)}>
          <p style={{ margin: 0 }}>
            {def.name} comes out of More and your lists. The things in it and their price history stay saved: make a section with it again
            to see them.
          </p>
          <div className="two">
            <button className="btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                const s = await getSaved();
                const sections = { ...s.sections, [section]: false };
                await saveNow({ sections });
                // 0.10.8: and the settings page agrees (an unsaved change to its tabs can't switch it back on)
                await updateSettings({ sections });
                setAsking(false);
                nav.pop();
                nav.toast(`${def.name} deleted`);
              }}
            >
              Delete
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
