import type { ReactNode } from 'react';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';

// Settings → Coming soon: what's planned, each with a short page saying what it'll do and what's
// here already. 0.15.0: shared prices (here) came off the list; each page is a sentence or two.

interface Soon {
  id: string;
  icon: string;
  title: string;
  short: string;
  body: ReactNode;
}

const SOON: Soon[] = [
  {
    id: 'inventory',
    icon: 'pantry',
    title: 'Running low',
    short: 'Suggestions to add things before you run out',
    body: (
      <>
        <p>Inventory (Settings) already keeps how much you have. Next, Restock learns how fast you use each thing and suggests adding it to your list before you run out, timed with a good price.</p>
      </>
    ),
  },
  {
    id: 'spending',
    icon: 'chart',
    title: 'Spending from receipts',
    short: 'Here now in Your data. Receipts as a source later',
    body: (
      <>
        <p>Your data already shows what you spent each month, from what you tick off your list. Later: a switch to work it out from your receipts instead.</p>
      </>
    ),
  },
  {
    id: 'iphone',
    icon: 'phone',
    title: 'iPhone and iPad',
    short: 'Widgets and the App Store are still to come',
    body: (
      <>
        <p>
          Restock runs on iPhone and iPad, installed from a computer for now:{' '}
          <a href="https://github.com/d-plenty/Restock/blob/main/docs/IPHONE.md" target="_blank" rel="noreferrer">
            how, and the warnings
          </a>
          .
        </p>
        <p>Still to come: home screen widgets, and the App Store.</p>
      </>
    ),
  },
  {
    id: 'github',
    icon: 'download',
    title: 'F-Droid',
    short: 'Restock in the main F-Droid repository',
    body: (
      <>
        <p>
          Restock is already in{' '}
          <a href="https://d-plenty.github.io/Restock/" target="_blank" rel="noreferrer">
            its own F-Droid repo
          </a>
          , with every release. Still to come: the main F-Droid repository, so you can find it without adding a repo.
        </p>
      </>
    ),
  },
];

/** The last section of Settings. */
export function ComingSoon() {
  const nav = useNav();
  return (
    <>
      <div className="card flush">
        {SOON.map((s) => (
          <button key={s.id} className="row" onClick={() => nav.push({ name: 'soon', id: s.id })} aria-label={`${s.title}: more about it`}>
            <Icon name={s.icon} size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                {s.title}
              </span>
              <span className="small">{s.short}</span>
            </span>
            <Icon name="chevron" size={18} />
          </button>
        ))}
      </div>
      <p className="small soon-foot">On the way. Each page says what's here already and what's still to come.</p>
    </>
  );
}

export function SoonScreen({ id }: { id: string }) {
  const s = SOON.find((x) => x.id === id);
  if (!s) return <div className="screen" />;
  return (
    <div className="screen">
      <TopBar title="Coming soon" />
      <div className="soon-head">
        <span className="soon-icon" aria-hidden="true">
          <Icon name={s.icon} size={26} />
        </span>
        <h1 style={{ margin: 0 }}>{s.title}</h1>
        <p className="sub" style={{ margin: 0 }}>
          {s.short}
        </p>
      </div>
      <div className="card soon-body">{s.body}</div>
      <p className="small">It'll show up in Settings when it's ready.</p>
    </div>
  );
}
