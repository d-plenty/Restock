// 0.12.0: the simpler rows. One row everywhere (Home, Pantry, search results): the photo, the name,
// the shop, one price and one word about it. Everything else about the price (what it was, what you
// save, the other shops) is behind the "i", in PriceInfoSheet.
import { useState, type ReactNode } from 'react';
import { addToList, takeOffList } from '../lib/listActions';
import { lastUpdatedText, productLine } from '../lib/unitPrice';
import { money } from '../lib/units';
import type { Option, Recommendation } from '../lib/verdict';
import { chainName, type Chain } from '../types';
import { ChainDot, Icon, SearchField, Sheet, Thumb } from './components';
import { useNav } from './nav';
import { MemberInfoTag, MultiInfoTag } from './tagInfo';

export type NoteTone = 'good' | 'warn' | 'plain';

/** The one word (or few) a row says about its price. */
export function recNote(r: Recommendation): { text: string; tone: NoteTone } | undefined {
  if (r.shelf?.gone.length) return { text: 'No longer sold?', tone: 'warn' };
  if (r.outOfStock) return { text: 'Out of stock', tone: 'warn' };
  if (r.shelf?.changed.some((c) => c.change.toQty < c.change.fromQty)) return { text: 'Smaller pack', tone: 'warn' };
  switch (r.action) {
    case 'buy':
      return { text: r.best?.verdict.kind === 'great' ? 'Great deal' : 'On special', tone: 'good' };
    case 'alt':
      return { text: 'Cheaper swap', tone: 'good' };
    case 'small':
      return { text: 'Small saving', tone: 'good' };
    case 'wait':
      return { text: 'Wait for a better special', tone: 'warn' };
    case 'skip':
      return { text: 'Not a real special', tone: 'warn' };
    default:
      return undefined;
  }
}

/** The option a row shows: the swap for a "cheaper swap", else your pick at its cheapest shop. */
export const shownOption = (r: Recommendation): Option | undefined => (r.action === 'alt' ? r.alt : r.best) ?? r.options[0];

export function ItemRow({
  photo,
  icon,
  name,
  chain,
  shopText,
  price,
  note,
  onOpen,
  openLabel,
  onInfo,
  action,
  lead,
  className,
}: {
  photo?: string;
  icon?: string;
  name: string;
  chain?: Chain;
  /** In place of the shop's name ("3 shops", "Any shop"). */
  shopText?: string;
  price?: number;
  note?: { text: string; tone: NoteTone };
  /** Tapping the row (not its buttons). */
  onOpen?: () => void;
  openLabel?: string;
  onInfo?: () => void;
  /** The button at the end: add, the cart, a tick. */
  action?: ReactNode;
  /** Before the photo (a select circle while editing). */
  lead?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`irow${className ? ` ${className}` : ''}`}>
      {onOpen && <button className="irow-hit" onClick={onOpen} aria-label={openLabel ?? name} />}
      {lead}
      <Thumb src={photo} icon={icon} />
      <span className="irow-text">
        <span className="irow-name">{name}</span>
        {(chain || shopText) && (
          <span className="irow-shop">
            {chain && <ChainDot chain={chain} />}
            {shopText ?? (chain ? chainName(chain) : '')}
          </span>
        )}
        <span className="irow-price">
          {price !== undefined && <span className="num">{money(price)}</span>}
          {note && <span className={`irow-note ${note.tone}`}>{note.text}</span>}
        </span>
      </span>
      {onInfo && (
        <button className="irow-i" aria-label={`About this price: ${name}`} onClick={onInfo}>
          <Icon name="info" size={24} />
        </button>
      )}
      {action}
    </div>
  );
}

/** The cart button at the end of a row of yours: on the list or not, one tap either way. */
export function ListButton({ rec, listed }: { rec: Recommendation; listed?: string }) {
  const nav = useNav();
  return (
    <button
      className={`cart-btn${listed ? ' on' : ''}`}
      aria-label={listed ? `${rec.group.name} is on your shopping list. Tap to take it off` : `Add ${rec.group.name} to shopping list`}
      aria-pressed={!!listed}
      onClick={async () => {
        if (listed) return void (await takeOffList([listed], rec.group.name));
        if (!(await addToList(rec.group))) nav.toast(`${rec.group.name} is already on your list`);
      }}
    >
      <Icon name={listed ? 'cartCheck' : 'cartPlus'} size={22} />
    </button>
  );
}

/** What the "i" opens for one of your items: is it a real special, and the numbers behind that. */
export function PriceInfoSheet({ rec, listed, onClose }: { rec: Recommendation; listed?: string; onClose: () => void }) {
  const nav = useNav();
  const o = shownOption(rec);
  const cur = o?.stats.current;
  const usual = o?.stats.typical ?? cur?.wasPrice;
  const price = o ? (o.multi ? o.shelfPrice : o.price) : undefined;
  const saved = usual !== undefined && price !== undefined && usual - price > 0.004 ? usual - price : undefined;
  // The other shops: each one's cheapest pick (two sizes at one shop are one line).
  const others = [...new Set(rec.options.filter((x) => x.role === 'main' && x.price !== undefined && x.product.chain !== o?.product.chain).map((x) => x.product.chain))].map(
    (c) => rec.options.filter((x) => x.role === 'main' && x.product.chain === c && x.price !== undefined).sort((a, b) => a.price! - b.price!)[0],
  );
  const good = rec.action === 'buy' || rec.action === 'alt' || rec.action === 'small';
  const line = o ? productLine(o.product, price) : '';
  return (
    <Sheet title={rec.group.name} onClose={onClose}>
      {o && (
        <div className="pinfo-head">
          <Thumb src={o.product.imageUrl} icon={rec.group.section ?? 'pantry'} />
          <span className="grow">
            <span className="pinfo-shop">
              <ChainDot chain={o.product.chain} /> {chainName(o.product.chain)}
            </span>
            <span className="small">{o.product.name}</span>
            <span className="small">{lastUpdatedText(cur?.date)}</span>
          </span>
        </div>
      )}
      <div className={`pinfo-verdict ${good ? 'good' : rec.action === 'none' ? 'plain' : 'warn'}`}>
        <strong>{rec.headline}</strong>
        {rec.detail && <span>{rec.detail}</span>}
        <span className="tags">
          {o && <MultiInfoTag o={o} />}
          {o && cur?.memberOnly && <MemberInfoTag chain={o.product.chain} hasCard={!o.locked} />}
        </span>
      </div>
      {o && (
        <dl className="pinfo-rows">
          <div>
            <dt>Now</dt>
            <dd className="num big">{money(price)}</dd>
          </div>
          {usual !== undefined && (
            <div>
              <dt>Usual price</dt>
              <dd className="num">{money(usual)}</dd>
            </div>
          )}
          {saved !== undefined && (
            <div>
              <dt>You save</dt>
              <dd className="num">{money(saved)}</dd>
            </div>
          )}
          {line && (
            <div>
              <dt>Size and unit price</dt>
              <dd>{line}</dd>
            </div>
          )}
          {o.stats.low !== undefined && (
            <div>
              <dt>Lowest Restock has seen</dt>
              <dd className="num">{money(o.stats.low)}</dd>
            </div>
          )}
          {others.map((x) => (
            <div key={x.product.id}>
              <dt>
                <ChainDot chain={x.product.chain} /> At {chainName(x.product.chain)}
              </dt>
              <dd className="num">{money(x.price)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="two">
        <button
          className="btn"
          onClick={() => {
            onClose();
            nav.push({ name: 'item', groupId: rec.group.id });
          }}
        >
          Price history
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            if (listed) await takeOffList([listed], rec.group.name);
            else if (!(await addToList(rec.group))) nav.toast(`${rec.group.name} is already on your list`);
            onClose();
          }}
        >
          <Icon name={listed ? 'cartCheck' : 'cartPlus'} size={18} /> {listed ? 'Take off list' : 'Add to list'}
        </button>
      </div>
    </Sheet>
  );
}

/** A row for one of your items (Home and Pantry): tap for its page, "i" for the numbers, the cart for the list. */
export function RecRow({ rec, listed, lead, onOpen, openLabel, hideActions }: { rec: Recommendation; listed?: string; lead?: ReactNode; onOpen?: () => void; /** What the row's button is called (Pantry: just the item's name, as before 0.12.0). */ openLabel?: string; hideActions?: boolean }) {
  const nav = useNav();
  const [info, setInfo] = useState(false);
  const o = shownOption(rec);
  const mains = rec.options.filter((x) => x.role === 'main');
  return (
    <>
      <ItemRow
        photo={(o ?? mains[0])?.product.imageUrl}
        icon={rec.group.section ?? 'pantry'}
        name={rec.group.name}
        chain={o?.product.chain}
        shopText={o ? undefined : 'No price yet'}
        price={o ? (o.multi ? o.shelfPrice : o.price) : undefined}
        note={recNote(rec)}
        lead={lead}
        onOpen={onOpen ?? (() => nav.push({ name: 'item', groupId: rec.group.id }))}
        openLabel={openLabel ?? `${rec.group.name}: ${rec.headline}`}
        onInfo={hideActions ? undefined : () => setInfo(true)}
        action={hideActions ? undefined : <ListButton rec={rec} listed={listed} />}
      />
      {info && <PriceInfoSheet rec={rec} listed={listed} onClose={() => setInfo(false)} />}
    </>
  );
}

/** Home's way in to adding: a search box and the barcode button. Both open Add on top. */
export function AddBar({ placeholder = 'Search the shops to add' }: { placeholder?: string }) {
  const nav = useNav();
  const [q, setQ] = useState('');
  return (
    <form
      className="add-bar"
      onSubmit={(e) => {
        e.preventDefault();
        const query = q.trim();
        setQ('');
        nav.push({ name: 'add', query: query || undefined });
      }}
    >
      <SearchField placeholder={placeholder} aria-label={placeholder} enterKeyHint="search" value={q} onValue={setQ} />
      <button type="button" className="btn primary add-bar-scan" aria-label="Scan a barcode" onClick={() => nav.push({ name: 'add', scan: true })}>
        <Icon name="scan" size={24} />
      </button>
    </form>
  );
}

/** A tab's one add button, with the barcode beside it ("Add to pantry", "Add to shopping list"). */
export function BigAdd({ label, onAdd, onScan }: { label: string; onAdd: () => void; onScan?: () => void }) {
  return (
    <div className="big-add">
      <button className="btn primary" onClick={onAdd}>
        <Icon name="plus" size={20} /> {label}
      </button>
      {onScan && (
        <button className="btn big-add-scan" aria-label="Scan a barcode" onClick={onScan}>
          <Icon name="scan" size={24} />
        </button>
      )}
    </div>
  );
}
