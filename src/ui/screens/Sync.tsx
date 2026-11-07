import { syncBackgroundSchedule } from '../../lib/check';
import { getSettings, updateSettings } from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { WEEKDAYS, type Settings } from '../../types';
import { TopBar } from '../components';

export function SyncScreen() {
  const settings = useLive(getSettings, []);
  if (!settings) return <div className="screen" />;
  const set = async (patch: Partial<Settings['sync']>) => {
    const s = await updateSettings({ sync: { ...settings.sync, ...patch } });
    if ('backgroundActivity' in patch) await syncBackgroundSchedule(s).catch((e) => console.error(e));
  };

  return (
    <div className="screen">
      <TopBar title="Sync" />

      <div className="banner blue">
        <strong>Sync arrives with the server beta</strong>
        <span style={{ fontSize: 13 }}>
          For now everything stays on this phone. Your choices below are saved and used once the self-hosted sync container is ready. Use Settings →
          Export a backup in the meantime.
        </span>
      </div>

      <div className="card flush">
        <label className="check">
          <input type="radio" name="mode" checked={settings.sync.mode === 'device'} onChange={() => set({ mode: 'device' })} />
          <span className="title" style={{ fontSize: 14, flex: 1 }}>
            This device only
          </span>
        </label>
        <label className="check">
          <input type="radio" name="mode" checked={settings.sync.mode === 'server'} onChange={() => set({ mode: 'server' })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 14 }}>
              Sync to my own server
            </span>
            <span className="small">Encrypted on this phone first. The server only holds scrambled data.</span>
          </span>
        </label>
      </div>

      {settings.sync.mode === 'server' && (
        <>
          <label className="field">
            <span>Server address</span>
            <input
              className="input"
              type="url"
              inputMode="url"
              placeholder="https://"
              defaultValue={settings.sync.serverUrl ?? ''}
              onBlur={(e) => set({ serverUrl: e.target.value.trim() || undefined })}
            />
          </label>

          <div className="eyebrow">When to sync</div>
          <div className="card flush">
            <label className="check">
              <input type="radio" name="when" checked={settings.sync.schedule === 'background'} onChange={() => set({ schedule: 'background' })} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 14 }}>
                  In the background
                </span>
                <span className="small">Soon after every change</span>
              </span>
            </label>
            <label className="check">
              <input type="radio" name="when" checked={settings.sync.schedule === 'daily'} onChange={() => set({ schedule: 'daily' })} />
              <span className="title" style={{ fontSize: 14, flex: 1 }}>
                Once a day
              </span>
            </label>
            <label className="check">
              <input type="radio" name="when" checked={settings.sync.schedule === 'weekly'} onChange={() => set({ schedule: 'weekly' })} />
              <span className="title" style={{ fontSize: 14, flex: 1 }}>
                Once a week
              </span>
              <select
                className="input"
                style={{ width: 'auto', height: 38, padding: '0 8px', fontSize: 14 }}
                value={settings.sync.weekday}
                onChange={(e) => set({ weekday: parseInt(e.target.value, 10), schedule: 'weekly' })}
                aria-label="Sync day"
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}

      <label className="card" style={{ flexDirection: 'row', alignItems: 'center' }}>
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="title" style={{ fontSize: 14 }}>
            Allow background activity
          </span>
          <span className="small">
            Checks prices about every 12 hours while the app is closed, when you're online. Uses Android's own scheduler, so it's battery friendly.
          </span>
        </span>
        <input
          type="checkbox"
          checked={settings.sync.backgroundActivity}
          onChange={(e) => set({ backgroundActivity: e.target.checked })}
          style={{ width: 22, height: 22, accentColor: 'var(--green)' }}
        />
      </label>
    </div>
  );
}
