// 0.9.4: Activity and logs for a house (from the server's srv_log, newest first): who joined, was
// removed, signed in, uploaded; and the logs (merges, Home Assistant rounds, problems). Never
// contents, never secrets. Both go with Auto delete (0.9.5; 0.9.4's "Keep data for").
import { useRef, useState, type KeyboardEvent } from 'react';
import { timeAgo } from '../../ui/components';
import { HousePage } from './DeskServer';
import { logsKeepText } from '../../lib/autoDelete';
import { isTrouble, useActivity, useHouseSettings, usePhonesV3, whatOf, whoOf } from './houseData';

type Part = 'activity' | 'logs';

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function Rows({ logs }: { logs: boolean }) {
  const { data, error, reload } = useActivity(logs);
  const phones = usePhonesV3();
  return (
    <>
      {error && <p className="banner red small">{error}</p>}
      {data?.length === 0 && <p className="small">Nothing yet.</p>}
      {data === undefined && !error && <p className="small">Loading…</p>}
      {data && data.length > 0 && (
        <div className="card flush">
          <ul className="house-log">
            {data.slice(0, 300).map((a, i) => (
              <li key={i} className={isTrouble(a) ? 'bad' : undefined}>
                <time dateTime={a.at} className="dk-sub num" title={timeAgo(a.at)}>
                  {when(a.at)}
                </time>
                <span>
                  <strong>{whoOf(a, phones.data)}</strong> {whatOf(a, phones.data)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button className="btn small dk-self-start" onClick={reload}>
        Refresh
      </button>
    </>
  );
}

export function ActivityLogs({ narrow }: { narrow?: boolean }) {
  const [part, setPart] = useState<Part>('activity');
  const { data: settings } = useHouseSettings();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const parts: { id: Part; label: string }[] = [
    { id: 'activity', label: 'Activity' },
    { id: 'logs', label: 'Logs' },
  ];
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const n = part === 'activity' ? 1 : 0;
    setPart(parts[n].id);
    tabs.current[n]?.focus();
  };
  return (
    <HousePage narrow={narrow} title="Activity and logs">
      <p className="small dk-tight">
        {part === 'activity'
          ? 'Who joined, was removed or left, signed in, and sent changes.'
          : 'What the server did: merging what phones sent, Home Assistant rounds, and anything that went wrong.'}{' '}
        Never what's in your lists, and never a passphrase or token. {logsKeepText(settings ? (settings.keepMonths ?? null) : undefined)}
      </p>
      <div className="dk-seg big dk-self-start" role="tablist" aria-label="Show" onKeyDown={onKey}>
        {parts.map((p, i) => (
          <button
            key={p.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            role="tab"
            id={`house-tab-${p.id}`}
            aria-selected={part === p.id}
            aria-controls="house-log-panel"
            tabIndex={part === p.id ? 0 : -1}
            onClick={() => setPart(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="house-log-panel" aria-labelledby={`house-tab-${part}`} className="dk-stack">
        <Rows key={part} logs={part === 'logs'} />
      </div>
    </HousePage>
  );
}
