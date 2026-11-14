import { useState } from 'react';
import { ACCENTS, AUS_GREEN, ICON_COLOURS, nearestIcon } from '../../lib/looks';
// 0.9.5 (save): on a settings screen these wait for Save settings (settingsDraft.ts).
import { afterSave, updateSettings } from '../../lib/settingsDraft';
import { RestockNative } from '../../lib/sql/native';
import { textOn } from '../../lib/theme';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { Icon, ThemePicker } from '../components';
import { useNav } from '../nav';

// Settings → Look and colours, and Settings → Accessibility. Also used by the setup tiles.

export function LookSettings({ settings }: { settings: Settings }) {
  const nav = useNav();
  const look = settings.look;
  const accent = look.accent ?? AUS_GREEN;
  const [iconBusy, setIconBusy] = useState(false);
  const setLook = (patch: Partial<Settings['look']>) => updateSettings({ look: { ...look, ...patch } });

  const iconId = look.icon === 'match' ? nearestIcon(accent).id : look.icon;
  const setIcon = async (id: string) => {
    await setLook({ icon: id });
    if (!isNative()) return;
    // 0.9.5 (save): the app icon changes once it's saved (with the accent it's saved with).
    await afterSave('icon', async (s) => {
      const real = s.look.icon === 'match' ? nearestIcon(s.look.accent ?? AUS_GREEN).id : s.look.icon;
      setIconBusy(true);
      try {
        await RestockNative.setAppIcon({ id: real });
        nav.toast('App icon changed. If it disappeared from your home screen, add it again from the app list.');
      } catch {
        nav.toast("Couldn't change the icon on this phone.");
      } finally {
        setIconBusy(false);
      }
    });
  };

  // With "Match my accent colour", the icon follows the accent (only when the nearest icon changes).
  const setAccent = async (hex: string | undefined) => {
    await setLook({ accent: hex });
    if (look.icon !== 'match' || !isNative()) return;
    const was = nearestIcon(accent).id;
    // 0.9.5 (save): once it's saved.
    await afterSave('icon-accent', async (s) => {
      if (s.look.icon !== 'match') return;
      const next = nearestIcon(s.look.accent ?? AUS_GREEN).id;
      if (next !== was) await RestockNative.setAppIcon({ id: next }).catch(() => undefined);
    });
  };

  return (
    <div className="card" style={{ gap: 14 }}>
      <div className="field">
        <span>Light or dark</span>
        <ThemePicker value={settings.theme} onChange={(theme) => updateSettings({ theme })} />
      </div>

      <label className="check" style={{ padding: 0 }}>
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            True black in dark mode
          </span>
          <span className="small">
            For OLED screens: the background is pure black, so those pixels switch off. Saves battery and gives deeper contrast. On to start with.
            {settings.theme === 'light' ? ' Shows when Light or dark is set to Dark or System.' : ''}
          </span>
        </span>
        <input type="checkbox" className="switch" checked={look.black !== false} onChange={(e) => void setLook({ black: e.target.checked })} />
      </label>

      <div className="field">
        <span>Style</span>
        <div className="seg" role="group" aria-label="Style">
          <button type="button" aria-pressed={look.style === 'australia'} onClick={() => setLook({ style: 'australia' })}>
            Australian
          </button>
          <button type="button" aria-pressed={look.style === 'plain'} onClick={() => setLook({ style: 'plain' })}>
            Plain
          </button>
        </div>
        <span className="small">Australian has navy bars with a gold line and a navy savings banner. Plain is simpler.</span>
      </div>

      {/* The colour grids are tucked away until you want them (0.7.3). */}
      <details className="pick-more">
        <summary>
          <span className="grow">Accent colour</span>
          <span className="small">{ACCENTS.find((a) => a.hex.toLowerCase() === accent.toLowerCase())?.name ?? 'Your own colour'}</span>
          <span className="pick-dot" style={{ background: accent }} aria-hidden />
          <Icon name="chevron" size={18} />
        </summary>
        <div className="field">
          <div className="swatches" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map((a) => {
              const on = (look.accent ?? AUS_GREEN).toLowerCase() === a.hex.toLowerCase();
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={a.name}
                  className={`swatch${on ? ' on' : ''}`}
                  style={{ background: a.hex, color: textOn(a.hex) }}
                  onClick={() => void setAccent(a.id === 'green' ? undefined : a.hex)}
                >
                  {on && <Icon name="check" size={16} stroke={3} />}
                </button>
              );
            })}
            <label
              className={`swatch wheel${ACCENTS.some((a) => a.hex.toLowerCase() === accent.toLowerCase()) ? '' : ' on'}`}
              aria-label="Pick any colour"
            >
              <input type="color" value={accent} onChange={(e) => void setAccent(e.target.value)} />
            </label>
          </div>
          <span className="small">
            Text on buttons switches between white and black by itself, so it stays readable. Shops keep their own colours.
          </span>
        </div>
      </details>

      <details className="pick-more">
        <summary>
          <span className="grow">App icon colour</span>
          <span className="small">{look.icon === 'match' ? 'Matches accent' : (ICON_COLOURS.find((c) => c.id === iconId)?.name ?? '')}</span>
          <span className="pick-dot" style={{ background: ICON_COLOURS.find((c) => c.id === iconId)?.hex }} aria-hidden />
          <Icon name="chevron" size={18} />
        </summary>
        <div className="field">
          <label className="check" style={{ padding: 0 }}>
            <input
              type="checkbox" className="switch"
              checked={look.icon === 'match'}
              onChange={(e) => void setIcon(e.target.checked ? 'match' : iconId)}
              disabled={iconBusy}
            />
            <span>Match my accent colour</span>
          </label>
          <div className="swatches" role="radiogroup" aria-label="App icon colour">
            {ICON_COLOURS.map((c) => {
              const on = iconId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`${c.name} icon`}
                  disabled={iconBusy}
                  className={`swatch icon${on ? ' on' : ''}`}
                  style={{ background: c.hex, color: textOn(c.hex) }}
                  onClick={() => void setIcon(c.id)}
                >
                  <Icon name="scan" size={16} stroke={2.6} />
                </button>
              );
            })}
          </div>
          <span className="small">
            The basket on the icon turns light or dark to suit the colour. On some phones changing the icon closes Restock for a moment, and you may
            need to put the icon back on your home screen.
          </span>
        </div>
      </details>
    </div>
  );
}

const TEXT_SIZES = [
  { v: 1, label: 'Normal' },
  { v: 1.15, label: 'Large' },
  { v: 1.3, label: 'Larger' },
  { v: 1.5, label: 'Largest' },
];

/** web: on the server's web page (Settings there), where it's this browser's own and sits under its own heading. */
export function AccessibilitySettings({ settings, web }: { settings: Settings; web?: boolean }) {
  const H = web ? 'h3' : 'h2';
  const a = settings.a11y;
  const set = (patch: Partial<Settings['a11y']>) => updateSettings({ a11y: { ...a, ...patch } });
  type Key = 'contrast' | 'motion' | 'big' | 'bold' | 'spacing' | 'links' | 'noSwipe' | 'slowMessages';
  const toggle = (key: Key, title: string, detail: string) => (
    <label className="check">
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <span className="title" style={{ fontSize: 15 }}>
          {title}
        </span>
        <span className="small">{detail}</span>
      </span>
      <input type="checkbox" className="switch" checked={!!a[key]} onChange={(e) => void set({ [key]: e.target.checked })} />
    </label>
  );
  return (
    <>
      <H className="eyebrow">Seeing</H>
      <div className="card flush">
        <div className="field" style={{ padding: '12px 14px' }}>
          <span id="a11y-text-size">Text size in Restock</span>
          <div className="seg seg-wrap" role="group" aria-labelledby="a11y-text-size">
            {TEXT_SIZES.map((t) => (
              <button key={t.v} type="button" aria-pressed={a.text === t.v} onClick={() => void set({ text: t.v })}>
                {t.label}
              </button>
            ))}
          </div>
          <span className="small">
            {web ? "On top of your browser's own text size, in this browser only." : "On top of your phone's own font size."} Everything grows together, so
            nothing gets cut off.
          </span>
        </div>
        {toggle('bold', 'Bold text', 'Heavier letters everywhere, easier to read.')}
        {toggle('contrast', 'High contrast', 'Darker grey text and stronger outlines on cards, buttons and boxes.')}
        {toggle('spacing', 'Easier reading spacing', 'More space between letters, words and lines. Can help with dyslexia.')}
        {toggle('links', 'Underline links', 'Links are underlined, not just coloured.')}
      </div>
      <H className="eyebrow">Moving and touching</H>
      <div className="card flush">
        {toggle('big', 'Bigger buttons', 'Every button and checkbox at least finger-sized.')}
        {toggle('noSwipe', 'No swiping', "Rows don't move when you swipe them. Everything a swipe does has a button too.")}
        {toggle('motion', 'Less motion', 'No sliding or popping animations. Restock also does this when your phone asks for less motion.')}
        {toggle('slowMessages', 'Messages stay longer', 'Messages at the bottom of the screen, and their Undo, stay three times as long.')}
      </div>
      <p className="small" style={{ margin: 0 }}>
        {web
          ? "These are this browser's own. The page works with screen readers and your browser's zoom. Every button says what it does."
          : "Restock works with TalkBack, Android's screen reader, and with your phone's own text size and display settings. Every button says what it does."}
      </p>
    </>
  );
}
