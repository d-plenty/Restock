import legal from '../../lib/legal.json';
import { Sheet } from '../components';

/** The privacy policy or the fine print, in full. */
export function LegalSheet({ doc, onClose }: { doc: 'privacy' | 'disclaimer'; onClose: () => void }) {
  const d = legal[doc];
  return (
    <Sheet title={d.title} onClose={onClose}>
      <p className="small">Last updated {legal.updated}</p>
      {'tagline' in d && <p style={{ fontWeight: 700, margin: 0, fontSize: 15, lineHeight: 1.4 }}>{(d as typeof legal.privacy).tagline}</p>}
      {'intro' in d && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45 }}>{(d as typeof legal.privacy).intro}</p>}
      {d.sections.map((s) => (
        <section key={s.title} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 17 }}>{s.title}</h3>
          {s.body.map((p) => (
            <p key={p.slice(0, 40)} style={{ margin: 0, fontSize: 15, lineHeight: 1.45, color: 'var(--ink-2)' }}>
              {p}
            </p>
          ))}
        </section>
      ))}
      {'outro' in d && (
        <p className="small" style={{ fontStyle: 'italic', textAlign: 'center', padding: '8px 12px 4px' }}>
          {(d as typeof legal.privacy).outro}
        </p>
      )}
    </Sheet>
  );
}
