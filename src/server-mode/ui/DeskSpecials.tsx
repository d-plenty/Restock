// 0.9.4 (design section 15): Specials and catalogues on the web, like the phone's.
// 0.12.3: like the phone, it shows only your own things on special: the page is Your shops (every
// shop the household follows, each with how many of your things are on special there, your
// specials page and the shop's own links), and Home's panel is the same counts. The shops' general
// half-price lists and My catalogue are gone from the web too (My catalogue is merged into each
// shop's page).
import { allListEntries, getSettings } from '../../lib/db';
import { shopTileNote } from '../../lib/ownSpecials';
import { ownCounts } from '../../lib/ownSpecialsLive';
import { loadRecommendations } from '../../lib/recs';
import { useLive } from '../../lib/useLive';
import { activeSections, enabledIn } from '../../shops';
import type { StoreProduct } from '../../stores/types';
import { ChainDot, Icon } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { HousePage } from './DeskServer';
import { useFollowed } from './houseData';
import { photoUrl } from './deskShared';
import { webLink } from '../../lib/site';

/** A shop's product picture: https, from a shop's picture host the page's CSP allows (else the box). */
export const thumbOf = (url: unknown) => photoUrl(url);

/** Words to match a special with a tracked product by name: lower case, letters and digits only. */
const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "chain|shop's id" and "chain|name" → the pantry item that tracks that product (0.9.5). */
export function trackedIndex(recs: { group: { id: string }; options: { product: { chain: string; storeProductId?: string; name: string } }[] }[]) {
  const m = new Map<string, string>();
  for (const r of recs)
    for (const o of r.options) {
      if (o.product.storeProductId) m.set(`${o.product.chain}|id|${o.product.storeProductId}`, r.group.id);
      m.set(`${o.product.chain}|name|${nameKey(o.product.name)}`, r.group.id);
    }
  return m;
}

export const trackedGroup = (index: Map<string, string>, p: Pick<StoreProduct, 'chain' | 'storeProductId' | 'name'>) =>
  (p.storeProductId ? index.get(`${p.chain}|id|${p.storeProductId}`) : undefined) ?? index.get(`${p.chain}|name|${nameKey(p.name)}`);

/** How many of your own things are on special at each shop the household follows (the phone's count). */
function useOwnCounts() {
  return useLive(async () => {
    const [r, s, e] = await Promise.all([loadRecommendations(), getSettings(), allListEntries()]);
    const chains = [...new Set(activeSections(s).flatMap((sec) => enabledIn(s.enabledChains, sec)))];
    return ownCounts(r, chains, e);
  }, []);
}

function ShopRow({ s, n }: { s: NonNullable<ReturnType<typeof useFollowed>>[number]['shops'][number]; n: number | undefined }) {
  const nav = useNav();
  const link = (raw: string | undefined, label: string, icon: string) => {
    // 0.10.1: only a web address is a link (it came from a phone's sync).
    const href = webLink(raw);
    return href ? (
      <a className="btn small" href={href} target="_blank" rel="noopener noreferrer" aria-label={`${s.name} ${label.toLowerCase()} (opens a new tab)`}>
        <Icon name={icon} size={16} /> {label}
      </a>
    ) : null;
  };
  return (
    <div className="dk-row">
      <span className="grow">
        <span className="dk-row-title">
          <ChainDot chain={s.chain} /> {s.name}
        </span>
        <span className="dk-sub">
          <span className={n ? 'shop-row-deals' : undefined}>{shopTileNote(n)}</span>
          {s.catalogueNote ? ` · ${s.catalogueNote}` : ''}
        </span>
      </span>
      <span className="dk-btns">
        <button className="btn small primary" onClick={() => nav.push({ name: 'shopcatalogue', chain: s.chain })} aria-label={`Your specials at ${s.name}`}>
          <Icon name="flame" size={16} /> Your specials
        </button>
        {link(s.catalogue, 'Catalogue', 'book')}
        {link(s.website, 'Website', 'external')}
      </span>
    </div>
  );
}

export function DeskSpecials({ narrow }: { narrow?: boolean }) {
  const followed = useFollowed();
  const counts = useOwnCounts();
  return (
    <HousePage narrow={narrow} title="Your shops">
      <section className="dk-stack" aria-label="Your shops">
        <p className="small dk-tight">
          Your specials shows the things your household buys that are on special at that shop. Catalogue and Website open the shop's own site, with
          everything else, in a new tab.
        </p>
        {followed?.map((g) => (
          <section key={g.section} className="card flush" aria-labelledby={`sp-${g.section}`}>
            <h3 id={`sp-${g.section}`} className="dk-card-title">
              {g.title}
            </h3>
            {g.shops.map((s) => (
              <ShopRow key={s.chain} s={s} n={counts?.get(s.chain)} />
            ))}
          </section>
        ))}
        {followed && !followed.length && <p className="small">No shops picked yet. Pick them in Settings → Your shops.</p>}
        <p className="small">Catalogue prices can differ by state and branch. Your items' prices are checked by your phones, so you don't need to hunt for them here.</p>
      </section>
    </HousePage>
  );
}

/** Home: how many of your things are on special at each shop (0.12.3: was half-price picks and My catalogue). */
export function HomeSpecials() {
  const nav = useNav();
  const followed = useFollowed();
  const counts = useOwnCounts();
  const shops = [...new Map((followed ?? []).flatMap((g) => g.shops).map((s) => [s.chain, s])).values()];
  const total = shops.reduce((t, s) => t + (counts?.get(s.chain) ?? 0), 0);
  return (
    <section className="card flush" aria-labelledby="home-sp">
      <div className="dk-section-head house-pad">
        <h2 id="home-sp">Your specials this week</h2>
        <button className="dk-linkish" onClick={() => nav.push({ name: 'specials' })}>
          Your shops
        </button>
      </div>
      {!counts ? (
        <p className="small house-pad" aria-busy="true">
          …
        </p>
      ) : !shops.length ? (
        <p className="small house-pad">No shops picked yet.</p>
      ) : (
        <>
          {total === 0 && <p className="small house-pad">Nothing your household buys is on special this week.</p>}
          {shops.map((s) => (
            <button key={s.chain} className="dk-row dk-row-btn" onClick={() => nav.push({ name: 'shopcatalogue', chain: s.chain })} aria-label={`${s.name}: ${shopTileNote(counts.get(s.chain))}`}>
              <span className="grow">
                <span className="dk-row-title">
                  <ChainDot chain={s.chain} /> {s.name}
                </span>
              </span>
              <span className={`dk-sub num${counts.get(s.chain) ? ' shop-row-deals' : ''}`}>{shopTileNote(counts.get(s.chain))}</span>
              <Icon name="chevron" size={16} />
            </button>
          ))}
        </>
      )}
    </section>
  );
}
