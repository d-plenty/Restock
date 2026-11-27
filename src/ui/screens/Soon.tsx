import type { ReactNode } from 'react';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';
import { appChannel } from '../../lib/updates';
import { isIos } from '../../lib/platform';

// Settings → Help → What's planned: what's coming in future releases, each with a short page. 0.18.1:
// rewritten as an app store's "coming soon" reads: the App Store and Google Play, F-Droid's main
// repository, widgets on the iPhone and iPad, and Running low. What's already here came off it.

interface Soon {
  id: string;
  icon: string;
  title: string;
  short: string;
  body: ReactNode;
}

const ALL_SOON: Soon[] = [
  {
    id: 'stores',
    icon: 'download',
    title: 'The App Store and Google Play',
    short: 'Restock in the official app stores',
    body: (
      <>
        <p>Restock is coming to the App Store and Google Play, so you can install it and get updates the usual way, with nothing set up by hand.</p>
        <p>Until then: on Android, from GitHub or Restock&rsquo;s own F-Droid repo; on iPhone and iPad, installed from a computer.</p>
      </>
    ),
  },
  {
    id: 'fdroid',
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
          , with every release. Coming: the main F-Droid repository, so you can find it in F-Droid without adding a repo.
        </p>
      </>
    ),
  },
  {
    id: 'widgets',
    icon: 'phone',
    title: 'Widgets on iPhone and iPad',
    short: 'Deals, your shopping list and quick actions on the home screen',
    body: (
      <>
        <p>The same three widgets Android has: Deals, Shopping list and Quick actions (Scan, List, Receipt), on your iPhone or iPad&rsquo;s home screen, in your colours.</p>
      </>
    ),
  },
  {
    id: 'inventory',
    icon: 'pantry',
    title: 'Running low',
    short: 'Suggestions to add things before you run out',
    body: (
      <>
        <p>Inventory (Settings) already keeps how much you have. Coming: Restock learns how fast you use each thing and suggests adding it to your list before you run out, timed with a good price.</p>
      </>
    ),
  },
];

/** What's coming for this version of the app: the store versions leave out the stores and F-Droid (they're installed from one), and Android leaves out the iPhone's widgets. */
function soonHere(): Soon[] {
  const c = appChannel();
  const store = c === 'play' || c === 'appstore';
  return ALL_SOON.filter((s) => {
    if (s.id === 'stores' || s.id === 'fdroid') return !store;
    if (s.id === 'widgets') return isIos() || c === 'appstore';
    return true;
  });
}

/** The last section of Settings. */
export function ComingSoon() {
  const nav = useNav();
  return (
    <>
      <div className="card flush">
        {soonHere().map((s) => (
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
  const s = soonHere().find((x) => x.id === id);
  // An old link to one that's here now (or no longer planned).
  if (!s)
    return (
      <div className="screen">
        <TopBar title="Coming soon" />
        <p className="small">That one isn&rsquo;t on the list any more: it&rsquo;s here now, or no longer planned.</p>
      </div>
    );
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
