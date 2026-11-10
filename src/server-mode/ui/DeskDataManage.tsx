// 0.9.5: Manage data, as on the approved concept ("Restock data tab", boards 2 and 3): what's on the
// server by kind (each with Delete…), Clean up old data (older than a date, from the kinds ticked),
// Auto delete (Off by default; 3, 6, 9, 12 or any number of months; replaces 0.9.4's Keep data for)
// held until Save settings, Refresh (Recount now, Ask phones to resend) and Delete everything on this
// server. Everything that deletes, turning Auto delete on or shorter too, goes through the two checks
// (DeskDataDialog.tsx). Nothing here deletes the shopping list, the pantry or each product's newest price.
import { useEffect, useMemo, useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import { Icon, useBackHandler } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { deleteLocalCopy, stop } from '../live';
import { remember, session } from '../session';
import { ApiError } from '../api';
import { HousePage } from './DeskServer';
import { TwoChecks, type TwoChecksProps } from './DeskDataDialog';
import { autoDeleteWords, measuredWords } from './DeskData';
import { monthsWord } from '../../lib/autoDelete';
import { bytesText, dayMonthYear, monthYear } from './dataCharts';
import { stepOne, stepTwo } from './deleteSteps';
import {
  ADMIN_NOTE,
  canAdmin,
  CLEAN_KINDS,
  data,
  DATA_KINDS,
  errText,
  KIND_NAME,
  usePhonesV3,
  useServer,
  WORD,
  WORD_ALL,
  type DataKind,
  type DataSummary,
  type Deleted,
} from './houseData';

const n = (v: number) => v.toLocaleString('en-AU');
const MONTH_MS = (365.25 / 12) * 86_400_000;
/** The cut-off for Auto delete after `months`, now (the server works it out the same way). */
export const autoCutoff = (months: number, now = Date.now()) => new Date(now - months * MONTH_MS).toISOString();

const KIND_SUB: Partial<Record<DataKind, string>> = {
  prices: 'Older prices. The newest price of each product always stays.',
  receipts: 'Pinned receipts stay.',
  stats: 'Each thing ticked off, behind the spending charts.',
  backups: 'Photos and price files the server deleted or replaced, in case you need them back. Not a backup: that is the one you download.',
};

function howMuch(s: DataSummary, k: DataKind): { main: string; sub?: string } {
  const x = s.kinds;
  switch (k) {
    case 'prices':
      return { main: `${n(x.prices.count)} prices`, sub: `${n(x.prices.products)} products` };
    case 'receipts':
      return {
        main: `${n(x.receipts.count)} receipts`,
        sub: [x.receipts.photos ? `${n(x.receipts.photos)} photos` : '', x.receipts.pinned ? `${n(x.receipts.pinned)} pinned` : ''].filter(Boolean).join(', ') || undefined,
      };
    case 'stats':
      return { main: `${n(x.stats.count)} ticked off` };
    case 'logs':
      return { main: `${n(x.logs.count)} entries`, sub: x.logs.activity ? `${n(x.logs.activity)} activity` : undefined };
    case 'backups':
      return { main: `${n(x.backups.count)} files` };
  }
}

/** "Deleted 9,870 prices, 198 receipts and 12 photos." from what the server says went. */
export function deletedWords(d: Deleted | null | undefined): string {
  if (!d) return 'Nothing was old enough to delete.';
  const bits = [
    d.prices ? `${n(d.prices)} price${d.prices === 1 ? '' : 's'}` : '',
    d.receipts ? `${n(d.receipts)} receipt${d.receipts === 1 ? '' : 's'}` : '',
    d.photos ? `${n(d.photos)} photo${d.photos === 1 ? '' : 's'}` : '',
    d.stats ? `${n(d.stats)} ticked item${d.stats === 1 ? '' : 's'}` : '',
    d.logs ? `${n(d.logs)} log entr${d.logs === 1 ? 'y' : 'ies'}` : '',
    d.backups ? `${n(d.backups)} deleted file${d.backups === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  if (!bits.length) return 'Nothing was old enough to delete.';
  const last = bits.pop();
  return `Deleted ${bits.length ? `${bits.join(', ')} and ${last}` : last}.`;
}

const STAYS = 'Your shopping list, pantry, the newest price of each product, pinned receipts, and everything on each phone.';

type Ask = { kind: 'kinds'; kinds: DataKind[]; before: string | null } | { kind: 'auto'; months: number } | { kind: 'all' };

/** Auto delete's choices: Off, 3, 6, 9, 12, or a number of months. */
type Choice = 'off' | '3' | '6' | '9' | '12' | 'custom';
const choiceOf = (m: number | null | undefined): Choice => (m === null || m === undefined ? 'off' : [3, 6, 9, 12].includes(m) ? (String(m) as Choice) : 'custom');

function AutoDelete({ summary, onAsk, onSaved }: { summary?: DataSummary; onAsk: (months: number) => void; onSaved: () => void }) {
  const nav = useNav();
  const saved = summary?.autoDelete.months ?? null;
  const [choice, setChoice] = useState<Choice>('off');
  const [custom, setCustom] = useState('24');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>();
  // What the server has, once it's known (and again after a save).
  useEffect(() => {
    if (!summary) return;
    setChoice(choiceOf(summary.autoDelete.months));
    if (choiceOf(summary.autoDelete.months) === 'custom') setCustom(String(summary.autoDelete.months));
  }, [summary]);
  const customN = Number(custom);
  const customOk = Number.isInteger(customN) && customN >= 1 && customN <= 120;
  const months: number | null | undefined = choice === 'off' ? null : choice === 'custom' ? (customOk ? customN : undefined) : Number(choice);
  const dirty = !!summary && months !== undefined && months !== saved;
  const shorter = months !== null && months !== undefined && (saved === null || months < saved);
  // Leaving with changes not saved asks first (Back, and closing or reloading the page).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useBackHandler(() => {
    void confirmAction('Leave without saving?', { detail: 'Your change to Auto delete is not saved yet.', action: 'Leave without saving', danger: true }).then(
      (ok) => ok && nav.pop(),
    );
    return true;
  }, dirty);
  const save = async () => {
    if (months === undefined || !dirty) return;
    setMsg(undefined);
    if (shorter) return onAsk(months);
    setBusy(true);
    try {
      await data.setAutoDelete(months);
      setMsg({ text: months === null ? 'Saved. Auto delete is off: nothing is deleted until you delete it.' : `Saved. Auto delete after ${monthsWord(months)}.` });
      onSaved();
    } catch (e) {
      setMsg({ text: errText(e), bad: true });
    } finally {
      setBusy(false);
    }
  };
  const radio = (value: Choice, label: string, extra?: string) => (
    <label className="dd-radio">
      <input type="radio" name="dd-auto" value={value} checked={choice === value} disabled={!summary || busy} onChange={() => (setChoice(value), setMsg(undefined))} />
      <span>
        {label}
        {extra && <span className="dk-sub-inline"> {extra}</span>}
      </span>
    </label>
  );
  return (
    <section className="card dd-card" aria-labelledby="dd-auto">
      <h2 id="dd-auto">Auto delete</h2>
      <span className="dk-sub">Deletes data older than this every night, from the same kinds as Clean up.</span>
      <fieldset className="dk-fieldset dd-fieldset">
        <legend className="small">Auto delete after</legend>
        {radio('off', 'Off', '(keep everything until I delete it)')}
        {radio('3', 'After 3 months')}
        {radio('6', 'After 6 months')}
        {radio('9', 'After 9 months')}
        {radio('12', 'After 12 months')}
        <div className="dd-custom">
          {radio('custom', 'After')}
          <label className="sr-only" htmlFor="dd-months">
            Number of months
          </label>
          <input
            id="dd-months"
            className="input dd-months"
            type="number"
            inputMode="numeric"
            min={1}
            max={120}
            value={custom}
            disabled={!summary || busy}
            aria-invalid={choice === 'custom' && !customOk}
            onFocus={() => setChoice('custom')}
            onChange={(e) => (setCustom(e.target.value.replace(/[^\d]/g, '').slice(0, 3)), setChoice('custom'), setMsg(undefined))}
          />
          <span className="small">months</span>
        </div>
        {choice === 'custom' && !customOk && <span className="dk-sub">Pick 1 to 120 months.</span>}
      </fieldset>
      <span className="dk-sub">
        Never deletes your shopping list, pantry, or the newest price of each product. Turning it on, or making it shorter, goes through the same two checks as deleting.
      </span>
      <div className="dd-save-row">
        <button type="button" className="btn primary dd-save" disabled={!dirty || busy || (shorter && !canAdmin())} onClick={() => void save()}>
          <Icon name="check" size={18} /> {busy ? 'Saving…' : 'Save settings'}
        </button>
        <span className="small" role="status">
          {dirty ? 'Not saved yet.' : summary ? `Saved: ${autoDeleteWords(summary.autoDelete)}.` : ''}
        </span>
      </div>
      {shorter && !canAdmin() && <span className="dk-sub">{ADMIN_NOTE}</span>}
      {msg && (
        <p className={`banner ${msg.bad ? 'red' : 'green'} small`} role={msg.bad ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}
    </section>
  );
}

const yearAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 0.9.5 (review): Step 1's exact numbers, from the server's dry run of that delete (nothing is
 * deleted). Undefined until it answers (Step 1 then says what the summary can).
 */
function useExactCounts(kinds: DataKind[] | undefined, before: string | null | undefined, on: boolean): Deleted | undefined {
  const key = on && kinds?.length ? `${kinds.join(',')}|${before ?? ''}` : '';
  const [got, setGot] = useState<{ key: string; counts: Deleted }>();
  useEffect(() => {
    if (!key || !kinds) return;
    let live = true;
    const t = setTimeout(() => {
      data.count(kinds, before ?? null).then(
        (r) => live && setGot({ key, counts: r.counts }),
        () => undefined,
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return got && got.key === key ? got.counts : undefined;
}

function CleanUp({ summary, onAsk }: { summary?: DataSummary; onAsk: (kinds: DataKind[], before: string) => void }) {
  const [date, setDate] = useState(yearAgo);
  const [kinds, setKinds] = useState<DataKind[]>(CLEAN_KINDS);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today();
  const before = valid ? new Date(`${date}T00:00:00`).toISOString() : null;
  const exact = useExactCounts(kinds, before, !!summary && !!before);
  const one = summary && before ? stepOne(summary, kinds, before, exact) : undefined;
  const toggle = (k: DataKind) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : CLEAN_KINDS.filter((x) => x === k || ks.includes(x))));
  return (
    <section className="card dd-card" aria-labelledby="dd-clean">
      <h2 id="dd-clean">Clean up old data</h2>
      <div className="dd-date">
        <label htmlFor="dd-before" className="small">
          Delete everything older than
        </label>
        <input id="dd-before" type="date" className="input dk-select" value={date} max={today()} onChange={(e) => setDate(e.target.value)} aria-invalid={!valid} />
      </div>
      {!valid && <span className="dk-sub">Pick a day in the past.</span>}
      <fieldset className="dk-fieldset dd-fieldset dd-kinds">
        <legend className="small">From</legend>
        {CLEAN_KINDS.map((k) => (
          <label key={k} className="dd-radio">
            <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggle(k)} />
            <span>{KIND_NAME[k]}</span>
          </label>
        ))}
      </fieldset>
      {one && (
        <div className="dd-note small" aria-live="polite">
          {one.goes.length > 0 && (
            <ul>
              {one.goes.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          )}
          {one.goes.length === 0 && one.none.length === 0 && <p>Pick at least one kind.</p>}
          {one.none.length > 0 && <p>{one.none.join(' ')}</p>}
        </div>
      )}
      <button
        type="button"
        className="btn danger dk-self-start"
        disabled={!summary || !before || !kinds.length || !one?.goes.length || !canAdmin()}
        onClick={() => before && onAsk(kinds, before)}
      >
        Delete older data…
      </button>
    </section>
  );
}

const ASK_TITLE: Record<DataKind, string> = {
  prices: 'Delete the older prices?',
  receipts: 'Delete the receipts and their photos?',
  stats: 'Delete what you ticked off?',
  logs: 'Delete the activity and logs?',
  backups: 'Delete the files kept for 30 days?',
};

export function DeskDataManage({ narrow }: { narrow?: boolean }) {
  const nav = useNav();
  const summary = useServer(() => data.summary());
  const phones = usePhonesV3();
  const [ask, setAsk] = useState<Ask>();
  const [busy, setBusy] = useState<'recount' | 'resend'>();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>();
  const s = summary.data;
  const admin = canAdmin();
  // 0.9.5 (review): the dialog's Step 1 says exactly what goes (Auto delete's cut-off worked out once).
  const askCut = useMemo(() => (ask?.kind === 'auto' ? autoCutoff(ask.months) : ask?.kind === 'kinds' ? ask.before : undefined), [ask]);
  const askKinds = ask?.kind === 'kinds' ? ask.kinds : ask?.kind === 'auto' ? CLEAN_KINDS : undefined;
  const exact = useExactCounts(askKinds, askCut, !!s && !!askKinds);

  const recount = async () => {
    setBusy('recount');
    setMsg(undefined);
    try {
      const r = await data.recount();
      setMsg({ text: `Recounted: ${n(r.checked)} ticked off checked, ${n(r.added)} added, ${n(r.removed)} taken back, ${n(r.repriced)} priced again.` });
      summary.reload();
    } catch (e) {
      setMsg({ text: errText(e), bad: true });
    } finally {
      setBusy(undefined);
    }
  };
  const resend = async () => {
    setBusy('resend');
    setMsg(undefined);
    try {
      await data.resend();
      setMsg({ text: 'Asked. Each phone sends everything it has again the next time it syncs (Restock 0.9.5 phones).' });
      summary.reload();
    } catch (e) {
      // 0.9.5 (review): asked less than a day ago: the server says when it can be asked again.
      const next = e instanceof ApiError && e.status === 429 && typeof e.extra?.next === 'string' ? e.extra.next : undefined;
      setMsg({ text: next ? `Phones were asked less than a day ago. You can ask again after ${new Date(next).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : errText(e), bad: true });
    } finally {
      setBusy(undefined);
    }
  };
  const nextResend = s?.resend.next && Date.parse(s.resend.next) > Date.now() ? s.resend.next : undefined;

  const dialog = useMemo((): Omit<TwoChecksProps, 'onDone' | 'onCancel'> | undefined => {
    if (!ask || !s) return undefined;
    if (ask.kind === 'kinds') {
      const one = stepOne(s, ask.kinds, ask.before, exact);
      const two = stepTwo(one, ask.before);
      return {
        title: ask.before ? `Delete data older than ${dayMonthYear(ask.before)}?` : ask.kinds.length === 1 ? ASK_TITLE[ask.kinds[0]] : 'Delete this data?',
        goes: one.goes,
        none: one.none,
        stays: STAYS,
        word: WORD,
        line: two.line,
        action: two.action,
        run: async (typed, confirm) => deletedWords((await data.delete(ask.kinds, ask.before, typed, confirm)).deleted),
      };
    }
    if (ask.kind === 'auto') {
      const cut = askCut ?? autoCutoff(ask.months);
      const one = stepOne(s, CLEAN_KINDS, cut, exact);
      return {
        title: `Auto delete after ${monthsWord(ask.months)}?`,
        lead: `Every night, data older than ${monthsWord(ask.months)} is deleted for everyone on this server. Saving deletes what's older than that straight away: everything from before ${dayMonthYear(cut)}. On the server now:`,
        goes: one.goes,
        none: one.none,
        stays: 'Your shopping list, pantry and the newest price of each item stay. So do pinned receipts and everything on each phone.',
        emptyOk: true,
        emptyText: 'Nothing on the server is that old yet, so nothing goes now. From now on, data goes every night once it is older than that.',
        word: WORD,
        line: `Your household's history older than ${monthsWord(ask.months)} will be gone for everyone on this server, now and every night.`,
        action: `Save: auto delete after ${monthsWord(ask.months)}`,
        run: async (typed, confirm) => {
          const r = await data.setAutoDelete(ask.months, typed, confirm);
          return `Saved. Auto delete after ${monthsWord(r.months ?? ask.months)}. ${deletedWords(r.deleted)}`;
        },
      };
    }
    const k = s.kinds;
    const active = phones.data?.filter((p) => !p.status || p.status === 'active').length;
    return {
      title: 'Delete everything on this server?',
      goes: [
        `The household: its shopping list, pantry, ${n(k.prices.count)} prices, ${n(k.receipts.count)} receipts and their photos, what you ticked off, and activity and logs. About ${bytesText(s.total)} in all.`,
        "The household's keys and Home Assistant settings, its token too.",
        `Every phone is unlinked${active !== undefined ? ` (${active} now)` : ''}: it stops syncing and keeps everything on it. You can add it again later.`,
      ],
      stays:
        "Everything on each phone. Your sign-in and the server's own settings (Auto delete, Let the web page search the shops). Afterwards the server asks to be set up again.",
      word: WORD_ALL,
      line: 'The server goes back to new and empty, for everyone.',
      action: 'Delete everything',
      run: async (typed, confirm) => {
        const r = await data.deleteEverything(typed, confirm);
        return `Deleted everything. ${r.phones} phone${r.phones === 1 ? ' was' : 's were'} unlinked.`;
      },
    };
  }, [ask, s, phones.data, exact, askCut]);

  const done = async (message: string) => {
    const wasAll = ask?.kind === 'all';
    setAsk(undefined);
    if (wasAll) {
      // The household is gone: this browser forgets its keys and its copy, and the page starts over
      // at Set up this server (the sign-in stays).
      const cur = session();
      stop();
      if (cur) {
        remember({ ...cur, keys: {}, household: undefined, ownerPub: undefined });
        await deleteLocalCopy(cur.webId);
      }
      location.reload();
      return;
    }
    setMsg({ text: message });
    nav.toast(message);
    summary.reload();
  };

  return (
    <HousePage
      narrow={narrow}
      title="Manage data"
      actions={
        narrow ? undefined : (
          <button type="button" className="btn" onClick={() => nav.pop()}>
            <Icon name="back" size={18} /> Your data
          </button>
        )
      }
    >
      <div className="dd-page">
        <p className="dk-sub dd-intro">
          This only changes what's kept on the server. Every phone keeps its own copy, and your shopping list and pantry are never deleted from here.
        </p>
        {!admin && (
          <p className="banner small" role="note">
            {ADMIN_NOTE}
          </p>
        )}
        {summary.error && (
          <p className="banner red small" role="alert">
            {summary.error}
          </p>
        )}
        <section className="card dd-card" aria-labelledby="dd-what">
          <div className="dd-card-head">
            <h2 id="dd-what">What's on this server</h2>
            <span className="dk-sub">{s ? `${bytesText(s.total)} in all · ${measuredWords(s)}` : 'Loading…'}</span>
          </div>
          {s && (
            <div className="dk-table-wrap dd-table-wrap">
              <table className="dk-table dd-table">
                <caption className="sr-only">What's on this server, by kind</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">How much</th>
                    <th scope="col">Oldest</th>
                    <th scope="col">Size</th>
                    <th scope="col">
                      <span className="sr-only">Delete</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {DATA_KINDS.map((k) => {
                    const h = howMuch(s, k);
                    const kind = s.kinds[k];
                    return (
                      <tr key={k}>
                        <td>
                          <strong>{KIND_NAME[k]}</strong>
                          {KIND_SUB[k] && <span className="dk-sub">{KIND_SUB[k]}</span>}
                        </td>
                        <td className="num">
                          {h.main}
                          {h.sub && <span className="dk-sub">{h.sub}</span>}
                        </td>
                        <td className="dk-nowrap">{(k === 'backups' ? dayMonthYear(kind.oldest) : monthYear(kind.oldest)) ?? '—'}</td>
                        <td className="num dk-nowrap">{bytesText(kind.bytes)}</td>
                        <td className="dk-end">
                          <button
                            type="button"
                            className="btn small danger"
                            disabled={!admin || kind.count === 0}
                            aria-label={`Delete ${KIND_NAME[k].toLowerCase()}…`}
                            onClick={() => setAsk({ kind: 'kinds', kinds: [k], before: null })}
                          >
                            Delete…
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div className="dd-row dd-even">
          <CleanUp summary={s} onAsk={(kinds, before) => setAsk({ kind: 'kinds', kinds, before })} />
          <AutoDelete summary={s} onAsk={(months) => setAsk({ kind: 'auto', months })} onSaved={summary.reload} />
        </div>
        <section className="card dd-band" aria-labelledby="dd-refresh">
          <span className="grow">
            <strong id="dd-refresh">Refresh</strong>
            <span className="dk-sub">
              Recount the charts and sizes now, or ask every phone to send all it has again if something looks missing.
              {s?.resend.at ? ` Phones were last asked ${dayMonthYear(s.resend.at)}.` : ''}
              {nextResend ? ` You can ask again after ${new Date(nextResend).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : ''}
            </span>
          </span>
          <span className="dk-btns">
            {/* 0.9.5 (review): Recount and Ask phones to resend are the passphrase's. */}
            <button type="button" className="btn" disabled={!!busy || !admin} onClick={() => void recount()}>
              <Icon name="refresh" size={18} /> {busy === 'recount' ? 'Recounting…' : 'Recount now'}
            </button>
            <button type="button" className="btn" disabled={!!busy || !!nextResend || !admin} onClick={() => void resend()}>
              {busy === 'resend' ? 'Asking…' : 'Ask phones to resend'}
            </button>
          </span>
        </section>
        {msg && (
          <p className={`banner ${msg.bad ? 'red' : 'green'} small`} role={msg.bad ? 'alert' : 'status'}>
            {msg.text}
          </p>
        )}
        <section className="card dd-band dd-band-danger" aria-labelledby="dd-all">
          <span className="grow">
            <strong id="dd-all">Delete everything on this server</strong>
            <span className="dk-sub">The server goes back to new and empty. Phones keep everything on them and stop syncing until you add them again.</span>
          </span>
          <button type="button" className="btn dd-danger-solid" disabled={!admin || !s} onClick={() => setAsk({ kind: 'all' })}>
            Delete everything…
          </button>
        </section>
      </div>
      {dialog && <TwoChecks key={ask?.kind} {...dialog} onCancel={() => setAsk(undefined)} onDone={(m) => void done(m)} />}
    </HousePage>
  );
}
