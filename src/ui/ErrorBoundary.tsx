import { Component, type ErrorInfo, type ReactNode } from 'react';
import { EVERYTHING, exportBackup } from '../lib/backup';
import { resetSettings } from '../lib/db';

// 0.9.0: if a screen breaks while it's being drawn, Restock shows this instead of a blank page.
// Everything on the phone is still there. "Try again" draws the app again; "Reset settings" puts
// only the settings back to how a new phone has them (a damaged setting is the usual reason a
// screen can't be drawn), keeping items, lists, prices, cards and receipts; "Export a backup"
// saves everything to a file first, in case.

interface State {
  error?: Error;
  busy?: boolean;
  note?: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Restock screen problem', error, info.componentStack);
  }

  private retry = () => this.setState({ error: undefined, busy: false, note: undefined });

  private reset = async () => {
    this.setState({ busy: true, note: undefined });
    try {
      await resetSettings();
      // Start fresh with the new settings, so nothing old is still in memory.
      window.location.reload();
    } catch (e) {
      this.setState({ busy: false, note: `Couldn't reset the settings: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  private backup = async () => {
    this.setState({ busy: true, note: undefined });
    try {
      const name = await exportBackup({ ...EVERYTHING, receiptPhotos: false });
      this.setState({ busy: false, note: `Backup ready: ${name}` });
    } catch (e) {
      this.setState({ busy: false, note: `Couldn't make a backup: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  render() {
    const { error, busy, note } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app">
        <div className="screen" role="alert">
          <h1>Something went wrong</h1>
          <p className="sub">Restock couldn't show this screen. Your items, lists, prices, cards and receipts are still safe on this phone.</p>
          <div className="card" style={{ gap: 10 }}>
            <button className="btn primary block" disabled={busy} onClick={this.retry}>
              Try again
            </button>
            <button className="btn block" disabled={busy} onClick={() => void this.backup()}>
              Export a backup
            </button>
            <button className="btn block" disabled={busy} onClick={() => void this.reset()}>
              Reset settings
            </button>
            <p className="small" style={{ margin: 0 }}>
              Reset settings puts your settings back to how a new phone has them: shops, alerts, colours and so on. Everything else stays. If
              you're not sure, export a backup first.
            </p>
            {note && (
              <p className="small" role="status" style={{ margin: 0 }}>
                {note}
              </p>
            )}
          </div>
          <p className="small" style={{ overflowWrap: 'anywhere' }}>
            What went wrong: {error.message || 'an unknown problem'}
          </p>
        </div>
      </div>
    );
  }
}
