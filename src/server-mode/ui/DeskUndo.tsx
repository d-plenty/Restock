// 0.9.5 (undo): the web's big white Undo, in the sidebar's foot above Sync now and Sign out. It
// shows for 8 seconds after each undoable action (undo.ts), then fades; it waits while the mouse
// or the keyboard is on it. Ctrl+Z (Cmd+Z on a Mac) does the same anywhere outside a text box
// (App.tsx), for a while longer.
import { useEffect, useRef, useState } from 'react';
import { onUndo, undo, type UndoStep } from '../../lib/undo';

const SHOW_MS = 8000;
const FADE_MS = 700;

export function UndoFoot() {
  const [step, setStep] = useState<UndoStep>();
  const [fading, setFading] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const left = useRef(SHOW_MS);

  const start = () => {
    window.clearTimeout(timer.current);
    if (held.current) return;
    timer.current = window.setTimeout(() => {
      setFading(true);
      timer.current = window.setTimeout(() => {
        setStep(undefined);
        setFading(false);
      }, FADE_MS);
    }, left.current);
  };

  useEffect(
    () =>
      onUndo((e) => {
        if (e.kind === 'added') {
          setStep(e.step);
          setFading(false);
          held.current = false;
          left.current = SHOW_MS;
          start();
        } else {
          window.clearTimeout(timer.current);
          setStep(undefined);
          setFading(false);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const hold = (on: boolean) => {
    held.current = on;
    if (on) {
      window.clearTimeout(timer.current);
      setFading(false);
    } else {
      left.current = 3000;
      start();
    }
  };

  // Screen readers hear what happened and where Undo is (the region always stays, so it's announced).
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {step ? `${step.label}. Undo is at the bottom of the sidebar, or press Control Z.` : ''}
      </span>
      {step && (
        <button
          type="button"
          className={`dk-undo${fading ? ' fading' : ''}`}
          onMouseEnter={() => hold(true)}
          onMouseLeave={() => hold(false)}
          onFocus={() => hold(true)}
          onBlur={() => hold(false)}
          onClick={() => void undo(step.id)}
          aria-keyshortcuts="Control+Z Meta+Z"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
          </svg>
          <span className="dk-undo-text">
            <strong>Undo</strong>
            <span className="dk-undo-what">{step.label}</span>
          </span>
        </button>
      )}
    </>
  );
}
