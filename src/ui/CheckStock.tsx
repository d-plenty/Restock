import { useState } from 'react';
import { cachedSettings } from '../lib/db';
import { checkStock, secondHasAll, type ShopStock, type StockItem } from '../lib/stockCheck';
import { isNative } from '../stores/http';
import { chainName } from '../shops';
import { ChainDot, Icon, LoadingBar, Sheet } from './components';

/**
 * 0.10.7: "Check stock" on the shopping list. Asks the shops about your branches now (not in the
 * background), and says what's not in stock where. Your second store is only suggested when it has
 * everything on your list for that shop.
 */
export function CheckStockButton({ items }: { items: StockItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="btn small"
        disabled={!items.length || !isNative()}
        title={isNative() ? undefined : 'Only in the Android app'}
        onClick={() => setOpen(true)}
      >
        <Icon name="box" size={16} /> {isNative() ? 'Check stock' : 'Check stock (in the Android app)'}
      </button>
      {open && <CheckStockSheet items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

function CheckStockSheet({ items, onClose }: { items: StockItem[]; onClose: () => void }) {
  const [step, setStep] = useState<{ done: number; total: number }>();
  const [shops, setShops] = useState<ShopStock[]>();
  const [error, setError] = useState<string>();
  const run = async () => {
    setError(undefined);
    setShops(undefined);
    setStep({ done: 0, total: items.length });
    try {
      setShops(await checkStock(items, cachedSettings(), (done, total) => setStep({ done, total })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStep(undefined);
    }
  };
  const missing = (s: ShopStock) => s.rows.filter((r) => r.main === 'out');
  const unsure = (s: ShopStock) => s.rows.filter((r) => r.main === 'unknown');
  return (
    <Sheet title="Check stock" onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        Restock asks your shops now what’s in stock at your stores, for the {items.length === 1 ? 'one thing' : `${items.length} things`} on this list. Stock
        can change during the day.
      </p>
      {!isNative() && <p className="small" style={{ margin: 0 }}>Checking stock works in the Android app: shops are asked from your phone.</p>}
      {!shops && !step && (
        <button className="btn primary block" disabled={!isNative()} onClick={() => void run()}>
          <Icon name="box" size={18} /> Check now
        </button>
      )}
      {step && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="small" role="status">
            Checking {step.done} of {step.total}…
          </span>
          <LoadingBar seconds={Math.max(6, step.total * 2)} />
        </div>
      )}
      {error && (
        <p className="small" role="alert">
          Couldn’t check: {error}
        </p>
      )}
      {shops && (
        <div style={{ display: 'grid', gap: 10 }} role="status">
          {shops.map((s) => (
            <div key={s.chain} className="card" style={{ gap: 6 }}>
              <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ChainDot chain={s.chain} /> {s.cant ? chainName(s.chain) : s.where}
              </strong>
              {s.cant ? (
                <span className="small">{s.cant}</span>
              ) : missing(s).length ? (
                <>
                  <span>
                    {missing(s).length === 1 ? '1 not in stock' : `${missing(s).length} not in stock`}: {missing(s).map((r) => r.name).join(', ')}
                  </span>
                  {secondHasAll(s) && (
                    <div className="banner green" style={{ margin: 0 }}>
                      <strong>{s.where2} has everything on your list.</strong>
                      <span style={{ fontSize: 13 }}>Go there instead?</span>
                    </div>
                  )}
                </>
              ) : (
                <span>Everything’s in stock{unsure(s).length ? ', as far as the shop says' : ''}.</span>
              )}
              {!s.cant && unsure(s).length > 0 && (
                <span className="small">
                  {s.where} didn’t say for: {unsure(s).map((r) => r.name).join(', ')}
                </span>
              )}
            </div>
          ))}
          <button className="btn" onClick={() => void run()}>
            Check again
          </button>
        </div>
      )}
    </Sheet>
  );
}
