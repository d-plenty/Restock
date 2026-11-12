import type { ReactNode } from 'react';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';

// Settings → Coming soon: what's planned, each with a page saying what it'll do. 0.9.5: some have a
// first part already (spending in the server's Data tab, Restock on iPhone through the server,
// Restock's own F-Droid repo); each page says what's here and what's still to come.

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
    title: 'Spending on your phone',
    short: 'On a Restock server now, in its Data tab. On the phone later',
    body: (
      <>
        <p>
          With a Restock server, it's here now: the server's <strong>Data</strong> tab shows what you spent each month, where you shop and what you
          saved on specials. It's worked out from what you tick off your shopping list (the price at the shop you ticked it at, times how many), not
          from receipts.
        </p>
        <p>Still to come: the same simple summary on the phone itself, with no server.</p>
        <p>
          Later, when reading receipts is better, a switch to use your receipts for spending instead. Restock isn't a budgeting app, so this stays
          light.
        </p>
      </>
    ),
  },
  {
    id: 'iphone',
    icon: 'phone',
    title: 'iPhone app',
    short: 'Restock on iPhone works now, through your server. An App Store app later',
    body: (
      <>
        <p>
          You can use Restock on iPhone now, through your own Restock server. Open the server's https address in Safari, tap Share, then{' '}
          <strong>Add to Home Screen</strong>. It opens like an app, and your Shopping list works with no signal.
        </p>
        <p>
          The server's sign-in page has the steps under <strong>On iPhone?</strong>, and so does the{' '}
          <a href="https://github.com/d-plenty/Restock#restock-on-iphone" target="_blank" rel="noreferrer">
            README
          </a>
          . It needs an https address, such as a Cloudflare tunnel or Tailscale's https.
        </p>
        <p>
          Still to come: a real iPhone app, with background price checks, alerts, widgets and Phone sharing. That needs a developer
          with an Apple developer account.
        </p>
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
          You can already get Restock through F-Droid, from{' '}
          <a href="https://d-plenty.github.io/Restock/" target="_blank" rel="noreferrer">
            Restock's own F-Droid repo
          </a>
          . Add it in F-Droid (or Droid-ify or Neo Store) and it keeps Restock up to date. It has every release, signed with the same key as the
          APK on GitHub.
        </p>
        <p>
          Still to come: Restock in the main F-Droid repository, built by F-Droid from the public code on{' '}
          <a href="https://github.com/d-plenty/Restock" target="_blank" rel="noreferrer">
            GitHub
          </a>
          , so you can find it in F-Droid without adding a repo.
        </p>
      </>
    ),
  },
  {
    id: 'sharedprices',
    icon: 'tag',
    title: 'Shared prices',
    short: 'Phones share shop prices now; Restock servers sharing with each other is next',
    body: (
      <>
        <p>
          Every price Restock sees could help everyone else: a new item would arrive with months of history, so you'd know straight away whether its
          "special" is real.
        </p>
        <p>
          The plan is a shared, decentralised network: Restock servers share shop price data with each other, instead of sending it to one
          central website or company. The prices will never be sold.
        </p>
        <p>It only ever shares prices and products:</p>
        <ul>
          <li>Each product's shop, name, brand, size and barcode.</li>
          <li>Its prices by day: the usual price, any special or multi-buy, and the date.</li>
        </ul>
        <p>And never anything personal:</p>
        <ul>
          <li>Who you are, your cards, your branch or where you live.</li>
          <li>The words you searched, your pantry, your shopping list or what you ticked off, your receipts, or prices you typed in. No account (a random number per install tells phones apart).</li>
        </ul>
        <p>
          It's "Send prices back" in Settings → Privacy and sharing: on unless you turn it off. Phones send the shop prices they read to
          restock-prices, and Judge new items from day one downloads the shared history back. Prices you type in yourself are never shared. Still to
          come: Restock servers sharing with each other. Restock will check the shops' terms before any prices are shared publicly.
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
      <p className="small">On the way. Each page says what's here already and what's still to come.</p>
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
