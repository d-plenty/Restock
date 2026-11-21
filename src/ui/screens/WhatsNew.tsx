// 0.12.9: Settings → What's new, and the box that offers it once after an update.
import { version } from '../../../package.json';
import { RELEASES } from '../../lib/updates';
import { WHATS_NEW } from '../../lib/whatsNew';
import { Icon, Sheet, TopBar } from '../components';
import { useNav } from '../nav';

export function WhatsNewScreen() {
  const nav = useNav();
  return (
    <div className="screen">
      <TopBar title="What's new" />
      <p className="small" style={{ margin: 0 }}>
        You have Restock {version}. The newest changes are first.
      </p>
      {WHATS_NEW.map((v) => (
        <section className="card whats-new" key={v.version} aria-label={`Restock ${v.version}`}>
          <h2>
            Restock {v.version}
            {v.version === version && <span className="whats-new-tag">This version</span>}
          </h2>
          <p className="small">{v.about}</p>
          <ul>
            {v.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      ))}
      <p className="small" style={{ margin: 0 }}>
        Older versions, and every detail of these, are on Restock's GitHub page.
      </p>
      <div className="whats-new-end">
        <button className="btn primary block" onClick={nav.pop}>
          Done
        </button>
        <a className="btn block" href={RELEASES} target="_blank" rel="noreferrer">
          <Icon name="external" size={18} /> Open the GitHub page
        </a>
      </div>
    </div>
  );
}

/** Shown once after an update: read what changed, or get on with it. */
export function WhatsNewPrompt({ onRead, onSkip }: { onRead: () => void; onSkip: () => void }) {
  return (
    <Sheet title={`Restock was updated to ${version}`} onClose={onSkip}>
      <p style={{ margin: 0 }}>Want to see what changed? You can read it any time in Settings, under What's new.</p>
      <button className="btn primary block" onClick={onRead}>
        See what's new
      </button>
      <button className="btn block" onClick={onSkip}>
        I'll figure it out
      </button>
    </Sheet>
  );
}
