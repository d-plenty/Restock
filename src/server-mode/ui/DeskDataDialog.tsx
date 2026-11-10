// 0.9.5: the two checks before the Data tab deletes anything, in a real modal dialog (the app's
// Sheet: focus kept inside, Escape cancels, focus goes back to the button that opened it).
// Step 1 says exactly what goes and what stays, with Download a backup first; Step 2 wants the word
// typed (DELETE, or DELETE EVERYTHING) and the passphrase again. A refusal from the server is said
// plainly and what was typed stays. The server checks both again (deleteSteps.ts keeps the steps).
import { useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react';
import { Icon, Sheet } from '../../ui/components';
import { confirmPassphrase } from '../session';
import type { Confirm } from '../api';
import { BackupSheet } from './DeskHouseSettings';
import { canDelete, firstStep, stepReducer, wordMatches } from './deleteSteps';
import { deleteError } from './houseData';

export interface TwoChecksProps {
  /** Step 1's question ("Delete data older than 10 Nov 2025?"). */
  title: string;
  /** Under the question (Auto delete says when and how often). */
  lead?: ReactNode;
  goes: ReactNode[];
  /** Kinds that lose nothing, said so (a date newer than their oldest). */
  none?: string[];
  stays: ReactNode;
  /** Go on even when nothing goes now (Auto delete: it's about every night from now on). */
  emptyOk?: boolean;
  /** What to say when nothing goes now. */
  emptyText?: string;
  word: string;
  /** Step 2's line ("About 88 MB of your household's history will be gone…"). */
  line: string;
  /** Step 2's button ("Delete 88 MB"). */
  action: string;
  /** Does it, with the typed word and the passphrase's proof; what it says comes back to onDone. */
  run: (typed: string, confirm: Confirm) => Promise<string>;
  onDone: (message: string) => void;
  onCancel: () => void;
}

export function TwoChecks({ title, lead, goes, none, stays, emptyOk, emptyText, word, line, action, run, onDone, onCancel }: TwoChecksProps) {
  const [s, dispatch] = useReducer(stepReducer, undefined, firstStep);
  const [backup, setBackup] = useState(false);
  const typedRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  // Step 2 starts at the typed word; Back goes to Step 1's Continue.
  const continueRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    // On opening, the sheet puts focus on its title (so the question is read first).
    if (!opened.current) {
      opened.current = true;
      return;
    }
    if (s.step === 2) typedRef.current?.focus();
    else continueRef.current?.focus();
  }, [s.step]);
  const go = async () => {
    if (!canDelete(s, word)) return;
    dispatch({ t: 'start', word });
    try {
      const proof = await confirmPassphrase(s.pass);
      const msg = await run(s.typed.trim(), proof);
      dispatch({ t: 'finished' });
      onDone(msg);
    } catch (e) {
      dispatch({ t: 'fail', error: deleteError(e) });
    }
  };
  const typedOk = wordMatches(s.typed, word);
  return (
    <>
      <Sheet title={s.step === 1 ? title : 'Last check: are you sure?'} onClose={() => !s.busy && onCancel()}>
        <div className="dd-dialog">
          <span className="dk-eyebrow">Step {s.step} of 2</span>
          {s.step === 1 ? (
            <>
              {lead && <p className="small">{lead}</p>}
              <div className="dd-goes">
                <strong>This deletes from the server</strong>
                {goes.length ? (
                  <ul>
                    {goes.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="small">{emptyText ?? 'Nothing of what you picked is that old, so nothing would go.'}</p>
                )}
                {none && none.length > 0 && !(goes.length === 0 && emptyText) && <p className="small dd-none">{none.join(' ')}</p>}
              </div>
              <div className="dd-stays">
                <strong>This stays</strong>
                <span className="small">{stays}</span>
              </div>
              <p className="small">It can't be undone, except from a backup you downloaded before.</p>
              <div className="dd-dialog-btns">
                <button type="button" className="btn" onClick={() => setBackup(true)}>
                  <Icon name="download" size={18} /> Download a backup first
                </button>
                <span className="grow" />
                <button type="button" className="btn" onClick={onCancel}>
                  Cancel
                </button>
                <button ref={continueRef} type="button" className="btn primary" disabled={goes.length === 0 && !emptyOk} onClick={() => dispatch({ t: 'continue' })}>
                  Continue
                </button>
              </div>
            </>
          ) : (
            <form
              className="house-form"
              onSubmit={(e) => {
                e.preventDefault();
                void go();
              }}
            >
              <p className="small">{line}</p>
              <label className="field" htmlFor={`${ids}-word`}>
                <span className="small">
                  Type <strong>{word}</strong> to confirm
                </span>
              </label>
              <input
                ref={typedRef}
                id={`${ids}-word`}
                className="input"
                value={s.typed}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-describedby={`${ids}-word-help`}
                aria-invalid={s.typed.length > 0 && !typedOk}
                onChange={(e) => dispatch({ t: 'typed', v: e.target.value })}
              />
              <span id={`${ids}-word-help`} className="dk-sub" aria-live="polite">
                {s.typed.length === 0 ? `In capitals, as shown.` : typedOk ? 'That matches.' : `Not yet: type ${word}, in capitals.`}
              </span>
              <label className="field" htmlFor={`${ids}-pass`}>
                <span className="small">Your passphrase</span>
              </label>
              <input
                id={`${ids}-pass`}
                className="input"
                type="password"
                autoComplete="current-password"
                value={s.pass}
                onChange={(e) => dispatch({ t: 'pass', v: e.target.value })}
              />
              {s.error && (
                <p className="banner red small" role="alert">
                  {s.error}
                </p>
              )}
              <div className="dd-dialog-btns">
                <button type="button" className="btn" disabled={s.busy} onClick={() => dispatch({ t: 'back' })}>
                  Back
                </button>
                <span className="grow" />
                <button type="submit" className="btn dd-danger-solid" disabled={!canDelete(s, word)}>
                  {s.busy ? 'Checking and deleting… (a few seconds)' : action}
                </button>
              </div>
            </form>
          )}
        </div>
      </Sheet>
      {backup && <BackupSheet onClose={() => setBackup(false)} />}
    </>
  );
}
