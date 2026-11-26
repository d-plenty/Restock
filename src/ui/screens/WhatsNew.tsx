// 0.12.9: Settings → What's new, and the box that offers it once after an update.
import { version } from '../../../package.json';
import { RELEASES } from '../../lib/updates';
import { skippedNotes, updatedFrom, WHATS_NEW } from '../../lib/whatsNew';
import { EARLIER } from '../../lib/whatsNewHistory';
import { Icon, Sheet, TopBar } from '../components';
import { useNav } from '../nav';

export function WhatsNewScreen() {
  const nav = useNav();
  // 0.12.10: the latest version only (it listed the last four, which was a lot to scroll past).
  const v = WHATS_NEW[0];
  const from = updatedFrom();
  const skipped = skippedNotes(from, v.version, EARLIER);
  return (
    <div className="screen">
      <TopBar title="What's new" />
      <section className="card whats-new" aria-label={`Restock ${v.version}`}>
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
      {/* 0.17.0: skipped an update or two? Each version since the one this phone had, one tap each. */}
      {skipped.length > 0 && (
        <>
          <h3 className="group-head">Also new since your last update{from ? ` (${from})` : ''}</h3>
          {skipped.map((e) => (
            <details key={e.version} className="card flush fold whats-new-old">
              <summary className="row">
                <span className="grow">
                  <span className="title">Restock {e.version}</span>
                  <span className="small">{e.about}</span>
                </span>
                <Icon name="chevron" size={18} />
              </summary>
              <ul className="whats-new-list">
                {e.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </details>
          ))}
        </>
      )}
      <p className="small" style={{ margin: 0 }}>
        Earlier versions, and every detail of this one, are on Restock's GitHub page.
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
