import { useEffect, useState } from 'react';
import { checkAll, openAppSettings, PERMISSIONS, request, type PermKey, type PermStatus } from '../../lib/permissions';
import { getSettings } from '../../lib/db';
import { scheduleReminders } from '../../lib/notify';
import { Icon, TopBar } from '../components';

/** The list of permissions with a reason and an Allow button each. Used in setup and Settings. */
export function PermissionList({ hideNote }: { hideNote?: boolean } = {}) {
  const [state, setState] = useState<Record<PermKey, PermStatus>>();
  const [busy, setBusy] = useState<PermKey | 'all'>();

  const refresh = () => checkAll().then(setState);
  useEffect(() => {
    void refresh();
    // Coming back from Android Settings: show the new answers.
    const onVis = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  if (!state) return null;
  const unsupported = Object.values(state).every((s) => s === 'unsupported');

  const ask = async (key: PermKey) => {
    setBusy(key);
    const result = await request(key);
    setBusy(undefined);
    setState((s) => ({ ...s!, [key]: result }));
    if ((key === 'notifications' || key === 'alarms') && result === 'granted') void scheduleReminders(await getSettings()).catch(() => undefined);
  };

  const askAll = async () => {
    setBusy('all');
    // Alarms opens Android's settings page rather than a pop-up, so it goes last, once the
    // others have been answered.
    const order = [...PERMISSIONS.filter((p) => p.key !== 'alarms'), ...PERMISSIONS.filter((p) => p.key === 'alarms')];
    for (const p of order) {
      if (state[p.key] === 'granted' || state[p.key] === 'unsupported') continue;
      const result = await request(p.key);
      setState((s) => ({ ...s!, [p.key]: result }));
    }
    setBusy(undefined);
    void scheduleReminders(await getSettings()).catch(() => undefined);
  };

  const anyMissing = PERMISSIONS.some((p) => state[p.key] !== 'granted');

  return (
    <>
      {unsupported && (
        <div className="banner grey">
          <span style={{ fontSize: 13 }}>Permissions are asked for in the Android app. In this preview there's nothing to allow.</span>
        </div>
      )}
      <div className="card flush">
        {PERMISSIONS.map((p) => {
          const s = state[p.key];
          return (
            <div key={p.key} className="row" style={{ alignItems: 'flex-start', padding: '14px' }}>
              <div className="perm" style={{ flex: 1 }}>
                <span className="perm-icon">
                  <Icon name={p.icon} size={20} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <span className="title" style={{ fontSize: 15 }}>
                    {p.title}
                  </span>
                  <span className="small" style={{ fontSize: 13 }}>
                    {p.why}
                  </span>
                  {s === 'granted' && (
                    <span className="perm-state ok">
                      <Icon name="check" size={16} /> Allowed
                    </span>
                  )}
                  {s === 'denied' && <span className="perm-state no">Turned off. Android won't ask again, so switch it on in Settings.</span>}
                </span>
              </div>
              {s === 'prompt' && (
                <button className="btn small primary" disabled={!!busy} onClick={() => ask(p.key)}>
                  {busy === p.key ? '…' : 'Allow'}
                </button>
              )}
              {s === 'denied' && (
                <button className="btn small" onClick={openAppSettings}>
                  Settings
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!unsupported && anyMissing && PERMISSIONS.some((p) => state[p.key] === 'prompt') && (
        <button className="btn primary block" disabled={!!busy} onClick={askAll}>
          {busy === 'all' ? 'Asking…' : 'Allow all'}
        </button>
      )}
      {!hideNote && (
        <p className="small">
          Android asks about each one in turn. For location, "While using the app" is all Restock needs. Alarms & reminders opens a settings page
          instead of a question, so Allow all opens it last. All of these are optional, and you can change them any time in Settings.
        </p>
      )}
    </>
  );
}

export function PermissionsScreen() {
  return (
    <div className="screen">
      <TopBar title="Permissions" />
      <PermissionList />
    </div>
  );
}
