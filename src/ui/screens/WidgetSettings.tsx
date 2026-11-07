import { updateSettings } from '../../lib/db';
import { textOn } from '../../lib/theme';
import { pushWidgetsSoon } from '../../lib/widgets';
import type { Settings } from '../../types';

// Settings → Home screen widgets: how all three widgets look. Adding one is done the usual way:
// press and hold the home screen, tap Widgets, find Restock.

const BACKGROUNDS: { id: Settings['widgets']['background']; label: string }[] = [
  { id: 'solid', label: 'Like the app' },
  { id: 'colour', label: 'A colour' },
  { id: 'none', label: 'None' },
];

export function WidgetSettings({ settings }: { settings: Settings }) {
  const w = settings.widgets;
  const set = async (patch: Partial<Settings['widgets']>) => {
    await updateSettings({ widgets: { ...w, ...patch } });
    pushWidgetsSoon(300);
  };
  const dark = settings.theme === 'dark';
  const bg = w.background === 'colour' ? w.colour : dark ? '#15213f' : '#ffffff';
  const ink = w.text !== 'auto' ? w.text : w.background === 'none' ? '#ffffff' : textOn(bg) === '#ffffff' ? '#ffffff' : '#0f1d3d';
  return (
    <div className="card">
      <p className="small" style={{ margin: 0 }}>
        Three widgets: <strong>Deals</strong>, <strong>Shopping list</strong> and <strong>Quick actions</strong> (Scan, List, Receipt). To add one,
        press and hold your home screen, tap Widgets and find Restock.
      </p>
      <div className="field">
        <span>Background</span>
        <div className="seg" role="radiogroup" aria-label="Widget background">
          {BACKGROUNDS.map((b) => (
            <button
              key={b.id}
              role="radio"
              aria-checked={w.background === b.id}
              className={w.background === b.id ? 'on' : ''}
              onClick={() => void set({ background: b.id })}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
      {w.background === 'colour' && (
        <label className="field">
          <span>Colour</span>
          <input
            type="color"
            className="input"
            style={{ height: 44, padding: 4 }}
            value={w.colour}
            onChange={(e) => void set({ colour: e.target.value })}
          />
        </label>
      )}
      {w.background !== 'none' && (
        <label className="field">
          <span>See-through: {w.transparency}%</span>
          <input
            type="range"
            min={0}
            max={90}
            step={5}
            value={w.transparency}
            onChange={(e) => void set({ transparency: parseInt(e.target.value, 10) })}
            aria-valuetext={`${w.transparency}% see-through`}
          />
        </label>
      )}
      <div className="field">
        <span>Text colour</span>
        <div className="seg" role="radiogroup" aria-label="Widget text colour">
          {[
            ['auto', 'Automatic'],
            ['#ffffff', 'White'],
            ['#0f1d3d', 'Dark'],
          ].map(([id, label]) => (
            <button key={id} role="radio" aria-checked={w.text === id} className={w.text === id ? 'on' : ''} onClick={() => void set({ text: id })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="widget-wall" aria-hidden="true">
        <div className="widget-preview" style={{ color: ink }}>
          <span
            className="widget-preview-bg"
            style={{ background: w.background === 'none' ? 'transparent' : bg, opacity: 1 - w.transparency / 100 }}
          />
          <strong>Shopping list · 3</strong>
          <span>☐ Milk</span>
          <span>☐ Bread</span>
          <span>☐ Vegemite</span>
        </div>
      </div>
      <p className="small" style={{ margin: 0 }}>
        "Automatic" text picks white or dark, whichever is easier to read on the background.
      </p>
    </div>
  );
}
