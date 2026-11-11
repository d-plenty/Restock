// 0.9.5: the web's Data tab, as on the approved concept ("Restock data tab", board 1): what the
// household's phones shared with this server, for a period (3 months · 6 months · 12 months · All):
// spending from what was ticked off the shopping list (not receipts), where you shop, one item's
// price over time, what you buy most (with a spreadsheet), storage on the server and disk free, and
// the downloads (spreadsheet, CSV, the full export file). Manage data (DeskDataManage.tsx) deletes.
// 0.9.6: Import beside the downloads (DeskDataImport.tsx); imported prices counted and tagged.
import { useEffect, useMemo, useRef, useState } from 'react';
import { allGroups } from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { money } from '../../lib/units';
import { monthsWord } from '../../lib/autoDelete';
import { chainName, SECTION_NAMES } from '../../shops';
import { Icon } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { householdInfo } from '../live';
import { HousePage } from './DeskServer';
import { PriceChart, PriceKey, ShopBars, SpendingChart, StorageBar } from './DeskDataCharts';
import { bytesText, dayMonthYear, monthYear, moneyShort, perMonth, periodWords, readPeriod, specialEvery, cheapestByWeek } from './dataCharts';
import { csvFiles, exportTables, fileBase, saveFile, withoutCostco, xlsxOf, XLSX_TYPE, type Table } from './exportFiles';
import { ImportCard } from './DeskDataImport';
import { allTop, canAdmin, data, errText, fullExport, KIND_NAME, PERIODS, useServer, type DataSummary, type Period, type TopItem } from './houseData';

const PERIOD_KEY = 'restock-data-period';
function savedPeriod(): Period {
  try {
    return readPeriod(localStorage.getItem(PERIOD_KEY));
  } catch {
    return 12;
  }
}

/** 3 months · 6 months · 12 months · All. */
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="dk-seg" role="group" aria-label="Time period">
      {PERIODS.map((p) => (
        <button key={String(p.value)} type="button" aria-pressed={value === p.value} onClick={() => onChange(p.value)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

const tabWords = (tabs: string[]) => (tabs.length ? tabs.map((t) => (t === 'pantry' ? 'Groceries' : ((SECTION_NAMES as Record<string, string>)[t] ?? t))).join(', ') : 'Groceries');

function Tile({ label, big, sub }: { label: string; big: string; sub: string }) {
  return (
    <div className="dk-tile">
      <span className="dk-tile-lab">{label}</span>
      <span className="dk-tile-big num">{big}</span>
      <span className="dk-tile-sub">{sub}</span>
    </div>
  );
}

const EMPTY_SPEND = 'Tick things off your shopping list and your spending shows up here.';

/** "since March 2025", and 0.9.6's "90,000 imported" (a 0.9.5 server doesn't say). */
function pricesSub(s: { prices: { first: string | null; imported?: number } } | undefined): string {
  if (!s) return '';
  const since = s.prices.first ? `since ${monthYear(s.prices.first)}` : 'none yet';
  const imported = Number(s.prices.imported) || 0;
  return imported > 0 ? `${since}, ${imported.toLocaleString('en-AU')} imported` : since;
}

// ---------- price over time ----------

function PriceOverTime({ period, pick, onPick, top }: { period: Period; pick?: string; onPick: (id: string) => void; top?: TopItem[] }) {
  const groups = useLive(allGroups, []);
  const [find, setFind] = useState('');
  const items = useMemo(
    () =>
      (groups ?? [])
        .filter((g) => !g.id.startsWith('demo-') && (g.usualProductId || g.sameProductIds.length || g.altProductIds.length))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [groups],
  );
  const shown = useMemo(() => {
    const w = find.trim().toLowerCase();
    return w ? items.filter((g) => g.name.toLowerCase().includes(w)) : items;
  }, [items, find]);
  // Until one's picked: the one bought most, else the first.
  const fallback = top?.find((t) => t.itemId && items.some((g) => g.id === t.itemId))?.itemId ?? items[0]?.id;
  const id = pick && items.some((g) => g.id === pick) ? pick : fallback;
  const { data: series, error } = useServer(async () => (id ? data.series(id, period) : undefined), [id, period]);
  const points = series ? cheapestByWeek(series.weeks) : [];
  const every = specialEvery(points);
  const current = series && series.item.id === id ? series : undefined;
  // 0.9.6: a week whose price came from an import (the server marks it).
  const imported = !!current?.weeks.some((w) => (w as { imported?: boolean }).imported);
  return (
    <section className="card dd-card" aria-labelledby="dd-price">
      <div className="dd-card-head">
        <h2 id="dd-price">
          Price over time{' '}
          {current && points.length > 0 && imported && (
            <span className="tag small normal dd-imported" title="Some of these prices came from a file you imported, not from a phone">
              imported
            </span>
          )}
        </h2>
        <div className="dd-picker">
          <label htmlFor="dd-pick" className="small">
            Item
          </label>
          <select id="dd-pick" className="input dk-select" value={id ?? ''} onChange={(e) => onPick(e.target.value)} disabled={!items.length}>
            {id && !shown.some((g) => g.id === id) && <option value={id}>{items.find((g) => g.id === id)?.name ?? 'This item'}</option>}
            {shown.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="dd-find">
            Find an item
          </label>
          <span className="dk-search dd-find">
            <Icon name="search" size={18} />
            <input
              id="dd-find"
              className="input"
              type="search"
              placeholder="Find an item"
              value={find}
              aria-describedby="dd-find-count"
              onChange={(e) => {
                setFind(e.target.value);
                // The first that matches shows straight away.
                const w = e.target.value.trim().toLowerCase();
                const first = w ? items.find((g) => g.name.toLowerCase().includes(w)) : undefined;
                if (first) onPick(first.id);
              }}
            />
          </span>
          <span id="dd-find-count" className="dk-sub" aria-live="polite">
            {find ? (shown.length === 0 ? 'No items match.' : `${shown.length} match${shown.length === 1 ? 'es' : ''}`) : ''}
          </span>
        </div>
      </div>
      {!items.length && groups && <p className="small">No items with prices yet. Add items on a phone and their prices show up here.</p>}
      {error && <p className="banner red small">{error}</p>}
      {current && points.length === 0 && (
        <p className="small">
          No prices for {current.item.name} in {periodWords(period)}.
        </p>
      )}
      {current && points.length > 0 && (
        <>
          <PriceKey usual={current.usual} />
          <PriceChart series={current} />
          <span className="small">
            {every
              ? `Best time to stock up: it's been on special ${every}.`
              : points.some((p) => p.special)
                ? `On special once in ${periodWords(period)}.`
                : `Not on special in ${periodWords(period)}.`}
            {current.paid.length > 0 &&
              ` You last paid ${money(current.paid[current.paid.length - 1].price)}${current.paid[current.paid.length - 1].chain ? ` at ${chainName(current.paid[current.paid.length - 1].chain!)}` : ''} on ${dayMonthYear(current.paid[current.paid.length - 1].at)}.`}
          </span>
        </>
      )}
      {!current && !error && id && <p className="small">Loading…</p>}
    </section>
  );
}

// ---------- what you buy most ----------

const PAGE = 10;

function topTable(items: TopItem[]): Table {
  return {
    name: 'What you buy most',
    columns: ['Item', 'Times bought', 'How many', 'Spent', 'Usual price', 'Last paid', 'Last paid at', 'Last bought', 'Cheapest now', 'Cheapest at'],
    rows: items.map((t) => ({
      Item: t.name,
      'Times bought': t.times,
      'How many': t.qty,
      Spent: t.total,
      'Usual price': t.usual,
      'Last paid': t.lastPaid?.price ?? null,
      'Last paid at': t.lastPaid?.chain ? chainName(t.lastPaid.chain) : null,
      'Last bought': t.lastAt,
      'Cheapest now': t.cheapest?.price ?? null,
      'Cheapest at': t.cheapest ? chainName(t.cheapest.chain) : null,
    })),
  };
}

function BuyMost({ period, onPick }: { period: Period; onPick: (id: string) => void }) {
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>();
  useEffect(() => setOffset(0), [period]);
  const { data: page, error } = useServer(() => data.top(period, offset, PAGE), [period, offset]);
  const download = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      const all = await allTop(period);
      const name = `${fileBase('what-you-buy-most')}.xlsx`;
      saveFile(xlsxOf([topTable(all)]), name, XLSX_TYPE);
      setMsg({ text: `Saved as ${name}.` });
    } catch (e) {
      setMsg({ text: errText(e), bad: true });
    } finally {
      setBusy(false);
    }
  };
  const total = page?.total ?? 0;
  return (
    <section className="card dd-card dd-wide-card" aria-labelledby="dd-top">
      <div className="dd-card-head">
        <h2 id="dd-top">What you buy most</h2>
        <button type="button" className="btn small" disabled={busy || !total} onClick={() => void download()}>
          <Icon name="download" size={16} /> {busy ? 'Making the spreadsheet…' : 'Download as a spreadsheet'}
        </button>
      </div>
      {error && <p className="banner red small">{error}</p>}
      {page && total === 0 && <p className="small">{EMPTY_SPEND}</p>}
      {page && total > 0 && (
        <div className="dk-table-wrap dd-table-wrap">
          <table className="dk-table dd-table">
            <caption className="sr-only">What you buy most, {periodWords(period)}, most often first</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Bought</th>
                <th scope="col">Usually</th>
                <th scope="col">Last paid</th>
                <th scope="col">Cheapest at</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((t) => (
                <tr key={t.key}>
                  <td>
                    {t.itemId ? (
                      <button type="button" className="dk-linkish dd-item" onClick={() => onPick(t.itemId!)} aria-label={`${t.name}: see its price over time`}>
                        {t.name}
                      </button>
                    ) : (
                      t.name
                    )}
                  </td>
                  <td className="num">{t.times}×</td>
                  <td className="num">{t.usual !== null ? money(t.usual) : '—'}</td>
                  <td className="num">
                    {t.lastPaid ? money(t.lastPaid.price) : '—'}
                    {t.lastPaid?.chain && <span className="dk-sub">{chainName(t.lastPaid.chain)}</span>}
                  </td>
                  <td>
                    {t.cheapest ? (
                      <>
                        {chainName(t.cheapest.chain)}
                        <span className="dk-sub num">{money(t.cheapest.price)} now</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && total > PAGE && (
        <div className="dk-pager" role="group" aria-label="Pages of what you buy most">
          <button type="button" className="btn dk-pager-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            <Icon name="back" size={20} /> Previous
          </button>
          <span className="dk-pager-at num" aria-live="polite">
            {offset + 1}–{Math.min(total, offset + PAGE)} of {total.toLocaleString('en-AU')}
          </span>
          <button type="button" className="btn dk-pager-btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Next <Icon name="chevron" size={20} />
          </button>
        </div>
      )}
      {msg && (
        <p className={`banner ${msg.bad ? 'red' : 'green'} small`} role={msg.bad ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}
    </section>
  );
}

// ---------- storage ----------

export const autoDeleteWords = (a: DataSummary['autoDelete'] | undefined) =>
  !a ? '…' : a.months === null ? 'Off' : `after ${monthsWord(a.months)}${a.cutoff ? ` (data from before ${dayMonthYear(a.cutoff)} is deleted every night)` : ''}`;

export function measuredWords(s: DataSummary): string {
  return s.measured === 'dbstat'
    ? 'Sizes measured from the database and files.'
    : "Sizes are estimates: this server's database can't measure each kind exactly, so they're worked out from what's in it.";
}

function oldestOf(s: DataSummary): string | undefined {
  const all = Object.values(s.kinds)
    .map((k) => k.oldest)
    .filter((v): v is string => !!v && Number.isFinite(Date.parse(v)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return all[0];
}

function StorageCard({ summary, error }: { summary?: DataSummary; error?: string }) {
  const nav = useNav();
  const oldest = summary ? oldestOf(summary) : undefined;
  return (
    <section className="card dd-card dd-side-card" aria-labelledby="dd-storage">
      <h2 id="dd-storage">Storage</h2>
      {error && <p className="banner red small">{error}</p>}
      {!summary && !error && <p className="small">Loading…</p>}
      {summary && (
        <>
          <div className="dd-used">
            <span className="dd-used-big num">{bytesText(summary.total)}</span>
            <span className="small">used{summary.disk ? ` · ${bytesText(summary.disk.free)} free on this disk` : ' · disk free not known on this server'}</span>
          </div>
          <StorageBar summary={summary} names={KIND_NAME} />
          <span className="dk-sub">{measuredWords(summary)}</span>
          <span className="small">
            Auto delete: {autoDeleteWords(summary.autoDelete)}.{oldest ? ` Oldest data from ${monthYear(oldest)}.` : ''}
          </span>
          <button type="button" className="dk-linkish dk-self-start" onClick={() => nav.push({ name: 'server', page: 'data-manage' })}>
            Manage and delete data
          </button>
        </>
      )}
    </section>
  );
}

// ---------- downloads ----------

type Kind = 'xlsx' | 'csv' | 'json';

function ExportCard() {
  const [busy, setBusy] = useState<Kind>();
  const [step, setStep] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>();
  const make = async (kind: Kind) => {
    setBusy(kind);
    setMsg(undefined);
    setStep('Asking the server…');
    try {
      // 0.9.6: never Costco's prices, whatever the server sent.
      const full = withoutCostco(await fullExport(setStep));
      setStep('Making the file…');
      const base = fileBase();
      let name: string;
      if (kind === 'json') {
        name = `${base}.json`;
        saveFile(JSON.stringify(full, null, 2), name, 'application/json');
      } else if (kind === 'xlsx') {
        name = `${base}.xlsx`;
        saveFile(xlsxOf(exportTables(full)), name, XLSX_TYPE);
      } else {
        const f = csvFiles(exportTables(full), base);
        name = f.name;
        saveFile(f.bytes, f.name, f.type);
      }
      const cut = full.truncated?.length ? ` Some tables were too big and stop at 50,000 rows: ${full.truncated.join(', ')}.` : '';
      setMsg({ text: `Saved as ${name}.${cut}` });
    } catch (e) {
      setMsg({ text: errText(e), bad: true });
    } finally {
      setBusy(undefined);
      setStep('');
    }
  };
  const btn = (kind: Kind, label: string, sub: string) => (
    <button type="button" className="dd-export-btn" disabled={!!busy} onClick={() => void make(kind)} aria-describedby={`dd-ex-${kind}`}>
      <Icon name="download" size={20} />
      <span className="grow">
        <strong>{busy === kind ? 'Getting everything…' : label}</strong>
        <span id={`dd-ex-${kind}`} className="dk-sub">
          {sub}
        </span>
      </span>
    </button>
  );
  return (
    <section className="card dd-card" aria-labelledby="dd-export">
      <div className="dd-card-head">
        <h2 id="dd-export">Download your data</h2>
      </div>
      <p className="small dd-tight">
        Everything on this server, all time: items, products, every price, your shopping list, what you ticked off, receipts (their details), shops and settings.
      </p>
      <div className="dd-export">
        {btn('xlsx', 'Spreadsheet (.xlsx)', 'One sheet for each kind, for Excel, Numbers or LibreOffice.')}
        {btn('csv', 'CSV files (.zip)', 'One CSV file for each kind, for any spreadsheet or database.')}
        {btn('json', 'Full export file (.json)', 'All of it in one file, to move your data to another machine.')}
      </div>
      {busy && (
        <p className="small" role="status">
          {step}
        </p>
      )}
      {msg && (
        <p className={`banner ${msg.bad ? 'red' : 'green'} small`} role={msg.bad ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}
      <span className="dk-sub">
        Never in it: card numbers and PINs, receipt text and photos, Costco prices, your passphrase, keys or the Home Assistant token. The encrypted backup (Settings) is the copy to
        restore a server from.
      </span>
    </section>
  );
}

// ---------- the page ----------

export function DeskData({ narrow }: { narrow?: boolean }) {
  const nav = useNav();
  const [period, setPeriodState] = useState<Period>(savedPeriod);
  const [pick, setPick] = useState<string>();
  const [busy, setBusy] = useState(false);
  const priceRef = useRef<HTMLDivElement>(null);
  const setPeriod = (p: Period) => {
    setPeriodState(p);
    try {
      localStorage.setItem(PERIOD_KEY, String(p));
    } catch {
      // fine: it's only remembered for next time
    }
  };
  const stats = useServer(() => data.stats(period), [period]);
  const summary = useServer(() => data.summary());
  const s = stats.data;
  const recount = async () => {
    setBusy(true);
    try {
      const r = await data.recount();
      nav.toast(`Recounted: ${r.added} added, ${r.removed} taken back, ${r.repriced} priced again.`);
      stats.reload();
      summary.reload();
    } catch (e) {
      nav.toast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const pickItem = (id: string) => {
    setPick(id);
    requestAnimationFrame(() => priceRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const avg = s ? perMonth(s.spending.months) : undefined;
  const spent = s?.spending;
  const none = !!spent && spent.count === 0;
  const tabs = householdInfo().tabs;
  return (
    <HousePage
      narrow={narrow}
      title="Your data"
      actions={
        <>
          {!narrow && <PeriodPicker value={period} onChange={setPeriod} />}
          {/* 0.9.5 (review): Recount is the passphrase's. */}
          <button type="button" className="btn" disabled={busy || !canAdmin()} onClick={() => void recount()}>
            <Icon name="refresh" size={18} /> {busy ? 'Recounting…' : 'Recount now'}
          </button>
          <button type="button" className="btn primary" onClick={() => nav.push({ name: 'server', page: 'data-manage' })}>
            Manage data
          </button>
        </>
      }
    >
      <div className="dd-page">
        {narrow && <PeriodPicker value={period} onChange={setPeriod} />}
        <p className="dk-sub dd-intro">
          Everything your phones shared with this server, for the whole household. Spending is what you ticked off the shopping list, at the price of the shop it was ticked at.
        </p>
        {stats.error && (
          <p className="banner red small" role="alert">
            {stats.error}
          </p>
        )}
        <div className="dk-tiles dd-tiles">
          <Tile
            label="Spent, from what you ticked off"
            big={s ? moneyShort(s.spending.total) : '…'}
            sub={!s ? '' : none ? 'Nothing ticked off yet' : avg !== undefined ? `about ${moneyShort(avg)} a month` : ''}
          />
          <Tile label="Saved on specials" big={s ? moneyShort(s.saved.total) : '…'} sub="against usual prices" />
          <Tile label="Items tracked" big={s ? s.itemsTracked.toLocaleString('en-AU') : '…'} sub={tabWords(tabs)} />
          <Tile label="Prices recorded" big={s ? s.prices.count.toLocaleString('en-AU') : '…'} sub={pricesSub(s)} />
        </div>
        <div className="dd-row">
          <section className="card dd-card dd-wide-card" aria-labelledby="dd-spend">
            <div className="dd-card-head">
              <h2 id="dd-spend">Spending each month</h2>
              <span className="dk-sub">
                {none ? '' : `From what you ticked off. ${s?.spending.months.length ? 'This month so far.' : ''}`}
                {spent && spent.unpriced > 0 ? ` ${spent.unpriced.toLocaleString('en-AU')} ticked without a price aren't in it.` : ''}
              </span>
            </div>
            {!s && !stats.error && <p className="small">Loading…</p>}
            {none && <p className="dd-empty">{EMPTY_SPEND}</p>}
            {s && !none && <SpendingChart months={s.spending.months} />}
          </section>
          <section className="card dd-card dd-side-card" aria-labelledby="dd-shops">
            <div className="dd-card-head">
              <h2 id="dd-shops">Where you shop</h2>
              <span className="dk-sub">Share of what you spent</span>
            </div>
            {none ? <p className="dd-empty">{EMPTY_SPEND}</p> : s ? <ShopBars shops={s.shops} /> : null}
          </section>
        </div>
        <div ref={priceRef} className="dd-anchor">
          <PriceOverTime period={period} pick={pick} onPick={setPick} top={s?.top.items} />
        </div>
        <div className="dd-row">
          <BuyMost period={period} onPick={pickItem} />
          <StorageCard summary={summary.data} error={summary.error} />
        </div>
        <ExportCard />
        <ImportCard
          onDone={() => {
            stats.reload();
            summary.reload();
          }}
        />
      </div>
    </HousePage>
  );
}
