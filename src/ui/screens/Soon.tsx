import type { ReactNode } from 'react';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';

// Settings → Coming soon: what's planned, each with a page saying what it'll do. Nothing here is
// switched on yet.

interface Soon {
  id: string;
  icon: string;
  title: string;
  short: string;
  body: ReactNode;
}

export const SOON: Soon[] = [
  {
    id: 'inventory',
    icon: 'pantry',
    title: 'What you have at home',
    short: 'Pantry stock levels and "running low" suggestions',
    body: (
      <>
        <p>
          Tell Restock roughly how much of something you have (a full bottle, two left, nearly out), and it keeps track as you buy and use things.
        </p>
        <p>
          It learns how fast you get through each one, so it can suggest adding things to your shopping list before you run out, and time it with a
          good price: "You're nearly out of coffee, and it's half price at Coles this week."
        </p>
        <p>Scanning a receipt or ticking things off your list in the shop would top your stock up for you.</p>
      </>
    ),
  },
  {
    id: 'spending',
    icon: 'chart',
    title: 'Spending summary',
    short: 'What you spent and saved, month by month',
    body: (
      <>
        <p>A simple monthly look at what you spent at each shop, from your kept receipts, and what Restock's deals saved you.</p>
        <p>
          It stays on your phone like everything else. Budgeting itself is planned as a separate app that works with Restock, so this stays light.
        </p>
      </>
    ),
  },
  {
    id: 'sync',
    icon: 'refresh',
    title: 'Sync away from home',
    short: 'Through a small server you run, when the phones aren’t on the same Wi-Fi',
    body: (
      <>
        <p>
          Phones in a household already sync on the same Wi-Fi (Settings → Sync). This adds syncing from anywhere: tick something off at the shops and
          it's off the list at home straight away.
        </p>
        <p>
          It would run on a small server you control: a Docker container on a home server, NAS or Raspberry Pi. There's no Restock account and no
          Restock server holding your data, and the server only ever sees encrypted data.
        </p>
      </>
    ),
  },
  {
    id: 'iphone',
    icon: 'phone',
    title: 'iPhone version',
    short: 'Restock on iOS, working with the Android version',
    body: (
      <>
        <p>The same Restock on iPhone, so a household with both kinds of phone can share a pantry and list once sync arrives.</p>
        <p>
          Restock is built so most of it already works on iPhone; the parts that talk to Android (background checks, widgets, alerts) need an iPhone
          version of their own.
        </p>
      </>
    ),
  },
  {
    id: 'homeassistant',
    icon: 'home',
    title: 'Home Assistant',
    short: 'Your shopping list in Home Assistant, both ways',
    body: (
      <>
        <p>
          Connect Restock to Home Assistant, so your shopping list shows there and changes go both ways: add milk from a kitchen tablet or by voice,
          and it's on your Restock list.
        </p>
        <p>Deals and recall alerts could show up in Home Assistant too. This comes after sync, as it uses the same server.</p>
      </>
    ),
  },
  {
    id: 'github',
    icon: 'download',
    title: 'F-Droid',
    short: 'Install and update Restock from F-Droid',
    body: (
      <>
        <p>
          Restock's code is already public on{' '}
          <a href="https://github.com/d-plenty/Restock" target="_blank" rel="noreferrer">
            GitHub
          </a>
          . Anyone can read it, check what it does with their data, report problems and suggest ideas there, and each new version's APK is
          downloadable from its Releases page.
        </p>
        <p>
          Next, Restock goes on F-Droid, the app store for free and open-source Android apps, so it can be installed and kept up to date without
          downloading APKs by hand.
        </p>
      </>
    ),
  },
  {
    id: 'sharedprices',
    icon: 'tag',
    title: 'Shared prices',
    short: 'A free public website of price history, so new items are judged from day one',
    body: (
      <>
        <p>
          Every price Restock sees could help everyone else: a new item would arrive with months of history, so you'd know straight away whether its
          "special" is real.
        </p>
        <p>If you choose to share (it's off unless you turn it on), Restock would send:</p>
        <ul>
          <li>Prices from searches and price checks: each product's shop, name, size, price, "was" price and the date.</li>
          <li>Prices from your receipts: each item, the price paid and the date, as read off the receipt.</li>
        </ul>
        <p>And it would never send:</p>
        <ul>
          <li>What you searched for, what's in your pantry, or what's on your list or ticked off.</li>
          <li>Receipt photos, totals, or anything that says who you are or where you live. No account, no phone ID.</li>
        </ul>
        <p>
          The shared prices would live on a free public website run by the developer, open to anyone, with no account needed. New phones could
          download the last six months of history, and the prices could be browsed on the website too. Restock would ask the shops for permission
          before this is offered publicly.
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
              <span className="title" style={{ fontSize: 14 }}>
                {s.title}
              </span>
              <span className="small">{s.short}</span>
            </span>
            <Icon name="chevron" size={18} />
          </button>
        ))}
      </div>
      <p className="small">On the way. Nothing here is switched on yet.</p>
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
      <p className="small">Not switched on yet. It'll show up in Settings when it's ready.</p>
    </div>
  );
}
