import { isIos } from '../../lib/platform';
import { useId, useState } from 'react';
import { ACCENTS, AUS_GREEN, ICON_COLOURS, ICON_PAINT, nearestIcon, SHOWN_ACCENTS, SHOWN_ICONS } from '../../lib/looks';
import { ColourWheel } from '../ColourWheel';
import { animationsSummary } from './Animations';
// 0.9.5 (save): on a settings screen these wait for Save settings (settingsDraft.ts).
import { afterSave, updateSettings } from '../../lib/settingsDraft';
import { RestockNative } from '../../lib/sql/native';
import { pickSimple, leaveSimple } from '../../lib/simple';
import { NAVY, textOn } from '../../lib/theme';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { Icon, LogoDrawing, More, ThemePicker } from '../components';
import { useNav } from '../nav';
import { useOpenSettingsPage } from '../settingsSide';

// Settings → Look and colours, and Settings → Accessibility. Also used by the setup tiles.

/** 0.17.0: an app icon colour, shown as the icon itself. */
function IconPicture({ id }: { id: string }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg className="icon-picture" viewBox="18 18 72 72" aria-hidden="true">
      <LogoDrawing id={uid} paint={ICON_PAINT[id] ?? ICON_PAINT.green} />
    </svg>
  );
}

/** 0.18.1: a row of colour swatches, then Restock's own colour wheel for any other colour. */
function Swatches({ label, value, onPick, first, wheelTitle }: { label: string; value: string | undefined; onPick: (hex: string | undefined) => void; first?: { name: string; hex: string }; wheelTitle: string }) {
  const [wheel, setWheel] = useState(false);
  const order = (id: string) => (SHOWN_ACCENTS.includes(id) ? SHOWN_ACCENTS.indexOf(id) : SHOWN_ACCENTS.length);
  const list = ACCENTS.filter((a) => SHOWN_ACCENTS.includes(a.id) || (!!value && a.hex.toLowerCase() === value.toLowerCase())).sort((a, b) => order(a.id) - order(b.id));
  const current = (value ?? first?.hex ?? '').toLowerCase();
  const own = !!value && !list.some((a) => a.hex.toLowerCase() === current) && current !== first?.hex.toLowerCase();
  const swatch = (key: string, name: string, hex: string, pick: string | undefined, on: boolean) => (
    <button key={key} type="button" role="radio" aria-checked={on} aria-label={name} className={`swatch${on ? ' on' : ''}`} style={{ background: hex, color: textOn(hex) }} onClick={() => onPick(pick)}>
      {on && <Icon name="check" size={16} stroke={3} />}
    </button>
  );
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {first && swatch('first', first.name, first.hex, undefined, !value)}
      {list.filter((a) => a.hex.toLowerCase() !== first?.hex.toLowerCase()).map((a) => swatch(a.id, a.name, a.hex, a.hex, !!value && a.hex.toLowerCase() === current))}
      <button type="button" role="radio" aria-checked={own} className={`swatch wheel${own ? ' on' : ''}`} aria-label="Pick any colour on the colour wheel" onClick={() => setWheel(true)}>
        {own && <Icon name="check" size={16} stroke={3} />}
      </button>
      {wheel && <ColourWheel title={wheelTitle} value={value ?? first?.hex ?? AUS_GREEN} onPick={(hex) => onPick(hex)} onClose={() => setWheel(false)} />}
    </div>
  );
}

const colourName = (hex: string | undefined, none: string) => (hex ? (ACCENTS.find((a) => a.hex.toLowerCase() === hex.toLowerCase())?.name ?? 'Your own colour') : none);

export function LookSettings({ settings }: { settings: Settings }) {
  const nav = useNav();
  const look = settings.look;
  const simple = look.style === 'simple';
  // 0.18.1: on the right, while Settings is side by side
  const openPage = useOpenSettingsPage();
  const accent = look.accent ?? AUS_GREEN;
  const [iconBusy, setIconBusy] = useState(false);
  const setLook = (patch: Partial<Settings['look']>) => updateSettings({ look: { ...look, ...patch } });

  const iconId = look.icon === 'match' ? nearestIcon(accent).id : look.icon;
  const order = (ids: string[]) => (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
  const shownIcons = ICON_COLOURS.filter((c) => SHOWN_ICONS.includes(c.id) || c.id === iconId).sort((a, b) => order(SHOWN_ICONS)(a.id) - order(SHOWN_ICONS)(b.id));
  const setIcon = async (id: string) => {
    await setLook({ icon: id, iconPicked: id !== 'match' });
    if (!isNative()) return;
    // 0.9.5 (save): the app icon changes once it's saved (with the accent it's saved with).
    await afterSave('icon', async (s) => {
      const real = s.look.icon === 'match' ? nearestIcon(s.look.accent ?? AUS_GREEN).id : s.look.icon;
      setIconBusy(true);
      try {
        const { ok } = await RestockNative.setAppIcon({ id: real });
        if (ok === false) throw new Error('not changed');
        nav.toast(isIos() ? 'App icon changed.' : 'App icon changed. If it disappeared from your home screen, add it again from the app list.');
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

  // 0.18.1: Simple turns the animations off and Less motion on (each can go back on); going back to
  // the default theme puts them back as they were.
  const pickStyle = async (style: Settings['look']['style']) => {
    if (style === look.style) return;
    const next = style === 'simple' ? pickSimple(settings) : leaveSimple(settings);
    await updateSettings(next);
    if (style === 'simple') {
      const reader = await simpleReaderNote();
      nav.toast(`Simple: the animations are off and Less motion is on. Turn any back on in Animations or Accessibility.${reader}`);
    }
  };

  const barDefault = simple ? { name: 'The same as the accent', hex: accent } : { name: 'Navy (the default)', hex: NAVY };

  return (
    <div className="card" style={{ gap: 14 }}>
      <div className="field">
        <span>Light or dark</span>
        <ThemePicker value={settings.theme} onChange={(theme) => updateSettings({ theme })} />
      </div>

      <div className="field">
        <span>Style</span>
        <div className="seg" role="group" aria-label="Style">
          {/* 0.16.0: "Default theme" (it was called Australian). 0.18.1: Simple replaced Plain. */}
          <button type="button" aria-pressed={!simple} onClick={() => void pickStyle('australia')}>
            Default theme
          </button>
          <button type="button" aria-pressed={simple} onClick={() => void pickStyle('simple')}>
            Simple
          </button>
        </div>
        <span className="small">
          {simple ? 'White, one colour, square and flat, and lighter work for older phones.' : 'Navy bars, gold and green.'}{' '}
          <More title="Style">
            <p>The default theme is Restock&rsquo;s Australian theme: navy, gold and green, the colours of the flag and the green and gold. On a holiday it takes that holiday&rsquo;s colours for a while (with Holiday themes on), then goes back by itself.</p>
            <p>Simple is white with one colour of your choice, a band of it at the top, square corners and no shadows. In dark mode it&rsquo;s plain black. It also goes easier on the phone: price checks take longer breaks, and charts are plainer. A good pick for an older phone or tablet.</p>
            <p>Picking Simple turns the opening animation and the holiday themes off and Less motion on. Turn any back on in Animations or Accessibility. Going back to the default theme puts them back as they were.</p>
          </More>
        </span>
      </div>

      {simple ? (
        <label className="check" style={{ padding: 0 }}>
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Accent band in dark mode
            </span>
            <span className="small">Off: dark mode is plain black. On: the coloured band stays at the top.</span>
          </span>
          <input type="checkbox" className="switch" checked={!!look.band} onChange={(e) => void setLook({ band: e.target.checked })} />
        </label>
      ) : (
        <label className="check" style={{ padding: 0 }}>
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              True black in dark mode
            </span>
            <span className="small">
              A pure black background in dark mode.{' '}
              <More title="True black in dark mode">
                <p>For OLED screens: the background is pure black, so those pixels switch off. It saves battery and gives deeper contrast.</p>
                <p>On to start with. It shows when Light or dark is set to Dark, or to System while your phone is in dark mode.</p>
              </More>
            </span>
          </span>
          <input type="checkbox" className="switch" checked={look.black !== false} onChange={(e) => void setLook({ black: e.target.checked })} />
        </label>
      )}

      {/* 0.18.1: the opening, the holidays and the previews are on their own page */}
      <button className="row look-anim-row" onClick={() => openPage('animations')}>
        <Icon name="star" size={18} />
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Animations
          </span>
          <span className="small">{animationsSummary(look)}</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>

      {/* The colour grids are tucked away until you want them (0.7.3). */}
      <details className="pick-more">
        <summary>
          <span className="grow">Accent colour</span>
          <span className="small">{colourName(look.accent, 'Australian green')}</span>
          <span className="pick-dot" style={{ background: accent }} aria-hidden />
          <Icon name="chevron" size={18} />
        </summary>
        <div className="field">
          <Swatches label="Accent colour" value={look.accent} first={{ name: 'Australian green', hex: AUS_GREEN }} onPick={(hex) => void setAccent(hex)} wheelTitle="Accent colour" />
          <span className="small">Buttons, links and ticks. Text on buttons switches between white and black by itself, so it stays readable. Shops keep their own colours.</span>
        </div>
      </details>

      {/* 0.18.1: the theme colour: the bars and tops */}
      <details className="pick-more">
        <summary>
          <span className="grow">Theme colour</span>
          <span className="small">{colourName(look.bar, simple ? 'Same as accent' : 'Navy')}</span>
          <span className="pick-dot" style={{ background: look.bar ?? barDefault.hex }} aria-hidden />
          <Icon name="chevron" size={18} />
        </summary>
        <div className="field">
          <Swatches label="Theme colour" value={look.bar} first={barDefault} onPick={(hex) => void setLook({ bar: hex })} wheelTitle="Theme colour" />
          <span className="small">
            {simple ? 'The band at the top of each screen.' : 'The top of each screen and the tab bar.'} Text on it turns white or black by itself.
            {!simple && ' With a colour of its own, the holidays keep to their openings.'}
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
            <input type="checkbox" className="switch" checked={look.icon === 'match'} onChange={(e) => void setIcon(e.target.checked ? 'match' : iconId)} disabled={iconBusy} />
            <span>Match my accent colour</span>
          </label>
          <div className="swatches" role="radiogroup" aria-label="App icon colour">
            {shownIcons.map((c) => {
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
                  <IconPicture id={c.id} />
                </button>
              );
            })}
          </div>
          <span className="small">
            {/* 0.18.0: an app icon can only be one the app came with, so the colour wheel has none of its own */}
            Your own colour from the colour wheel? The icon uses the closest of these.{' '}
            <More title="App icon colour">
              <p>Phones only take app icons that come with the app, so there&rsquo;s one for each of these colours and none for a colour of your own. Match my accent colour uses the same colour as your accent, or the closest one.</p>
              <p>The basket on the icon turns light or dark to suit the colour.</p>
              {!isIos() && <p>On some phones changing the icon closes Restock for a moment, and you may need to put the icon back on your home screen.</p>}
            </More>
          </span>
        </div>
      </details>
    </div>
  );
}

/** 0.18.1: picking Simple with the photo reader downloaded: say it's kept, and where it can go. */
async function simpleReaderNote(): Promise<string> {
  try {
    const { readerDownloaded, READER_SIZE_TEXT } = await import('../../lib/readerModels');
    if (!(await readerDownloaded())) return '';
    return ` The photo reader (${READER_SIZE_TEXT}) stays downloaded: remove it in Settings → Shopping list and receipts if you don't use it.`;
  } catch {
    return '';
  }
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
        {toggle('motion', 'Less motion', 'No sliding or popping animations, and the opening animation is a still picture. Restock also does this when your phone asks for less motion.')}
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
