// 0.14.0: on Home, a loyalty card that runs out within a month (or has): "Your Flybuys card expires
// in 1 month", with Update (the card, to change its date or replace it) and Remind me later (a week;
// a day once it's a week away). Like the backup reminder: it comes back until it's dealt with.
import { getKV, putKV } from '../../lib/db';
import { cardsToMention, putOffCard } from '../../lib/giftCards';
import { phoneCards, type CardStore } from '../../lib/cardStore';
import { useLive } from '../../lib/useLive';
import { useNav } from '../nav';

export const CARD_LATER_KV = 'cardExpiryLater';

export function CardExpiryNotice({ store = phoneCards }: { store?: CardStore }) {
  const nav = useNav();
  const cards = useLive(() => store.loyalty().catch(() => []), [store]);
  const later = useLive(() => getKV<Record<string, string>>(CARD_LATER_KV).then((v) => v ?? {}), []);
  if (!cards || !later) return null;
  const due = cardsToMention(cards, later);
  if (!due.length) return null;
  return (
    <>
      {due.slice(0, 3).map(({ card, words, expired }) => (
        <div key={card.id} className={`banner ${expired ? 'red' : 'amber'}`} role="status" style={{ gap: 8 }}>
          <strong>
            Your {card.label} card {words}
          </strong>
          <span style={{ fontSize: 13 }}>{expired ? 'Put in the new card, or its new date.' : 'Got a new one? Put in its date, or replace the card.'}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small primary" onClick={() => nav.push({ name: 'cards' })}>
              Update
            </button>
            <button className="btn small" onClick={() => void putKV(CARD_LATER_KV, putOffCard(card, later))}>
              Remind me later
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
