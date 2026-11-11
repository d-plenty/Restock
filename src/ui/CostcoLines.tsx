import type { StoreProduct } from '../stores/types';

/**
 * 0.9.6: what only Costco's page says, on its own lines under a result: "Online price, includes delivery",
 * "Minimum 2 when buying online", "Can't ship to QLD", "Member only", the special's end date, out of stock.
 * The words come from lib/costcoNotice.ts (stores/costco.ts makes the notes). Nothing for any other shop.
 */
export function CostcoLines({ sp }: { sp: Pick<StoreProduct, 'chain' | 'costco'> }) {
  const notes = sp.chain === 'costco' ? sp.costco?.notes : undefined;
  if (!notes?.length) return null;
  return (
    <span className="costco-lines" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {notes.map((n) => (
        <span key={n} className="small">
          {n}
        </span>
      ))}
    </span>
  );
}
