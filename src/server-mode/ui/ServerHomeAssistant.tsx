// 0.9.4: Home Assistant in a house runs on the server (design section 9, D12): one list, one
// token, around the clock. Address, Test connection, which list, the token (write-only: it goes
// sealed and never comes back), on or off, and Sync now. If Home Assistant still runs on a phone
// with Restock 0.9.3, the server waits until that phone is updated or the admin ticks that it's off.
import { useEffect, useState } from 'react';
import { timeAgo } from '../../ui/components';
import { api3, type HaConfig } from '../api';
import { HousePage } from './DeskServer';
import { ADMIN_NOTE, canAdmin, errText, useHa } from './houseData';

export const HA_SHARED = 'Every phone and browser on this server shares this Home Assistant shopping list.';

export function ServerHomeAssistant({ narrow }: { narrow?: boolean }) {
  const { data, error, reload } = useHa();
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [entity, setEntity] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [lists, setLists] = useState<{ entity: string; name?: string }[]>();
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>();
  const [phoneOff, setPhoneOff] = useState(false);
  useEffect(() => {
    if (!data) return;
    setAddress(data.address ?? '');
    setEntity(data.entity ?? '');
    setEnabled(!!data.enabled);
    setPhoneOff(!!data.phone && data.offOn === data.phone);
  }, [data]);

  const body = (): HaConfig & { token?: string } => ({ address: address.trim(), entity: entity.trim(), enabled, ...(token.trim() ? { token: token.trim() } : {}), ...(data?.phone ? { offOn: phoneOff ? data.phone : null } : {}) });
  const run = async (what: string, fn: () => Promise<{ text: string; bad?: boolean } | void>) => {
    setBusy(what);
    setMsg(undefined);
    try {
      const m = await fn();
      if (m) setMsg(m);
    } catch (e) {
      setMsg({ text: errText(e), bad: true });
    } finally {
      setBusy(undefined);
    }
  };
  const test = () =>
    run('Testing…', async () => {
      const r = await api3.testHomeAssistant(body());
      if (r.lists?.length) {
        setLists(r.lists);
        if (!entity && r.lists.length === 1) setEntity(r.lists[0].entity);
      }
      return { text: r.message ?? (r.ok ? 'Connected to Home Assistant.' : "Couldn't connect."), bad: !r.ok };
    });
  const save = () =>
    run('Saving…', async () => {
      await api3.putHomeAssistant(body());
      setToken('');
      reload();
      return { text: enabled ? `Saved. ${HA_SHARED}` : 'Saved. Home Assistant is off on the server.' };
    });
  const syncNow = () =>
    run('Syncing…', async () => {
      const r = await api3.syncHomeAssistant();
      reload();
      return { text: r.message ?? (r.ok ? 'Synced the shopping list with Home Assistant.' : "Couldn't sync."), bad: r.ok === false };
    });
  const waiting = !!data?.phone && data.phoneApi !== null && (data.phoneApi ?? 2) < 3 && data.offOn !== data.phone;
  return (
    <HousePage narrow={narrow} title="Home Assistant">
      <p className="small dk-tight">
        The shopping list both ways with Home Assistant's to-do list, run by this server every minute. {HA_SHARED} Phones on this server don't run their own.
      </p>
      {error && <p className="banner red small">{error}</p>}
      {data?.phone && data.phoneApi !== null && (data.phoneApi ?? 2) < 3 && (
        <div className={`banner ${waiting ? 'amber' : 'grey'} small`} role="note">
          <span>
            Home Assistant still runs on {data.phoneName ?? 'a phone'} (Restock 0.9.3). Update Restock on it to move Home Assistant here, or turn Home Assistant off
            on it and set it up here.
          </span>
          <label className="check">
            <input type="checkbox" checked={phoneOff} onChange={(e) => setPhoneOff(e.target.checked)} />
            <span>It's off on {data.phoneName ?? 'that phone'}</span>
          </label>
        </div>
      )}
      <form
        className="card house-form house-ha"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        aria-busy={!data && !error}
      >
        {!canAdmin() && (
          <p className="small" role="note">
            {ADMIN_NOTE}
          </p>
        )}
        <fieldset className="dk-fieldset house-form" disabled={!canAdmin()}>
        <legend className="sr-only">Home Assistant on the server</legend>
        <label htmlFor="ha-address" className="house-label">
          Home Assistant's address
        </label>
        <input
          id="ha-address"
          className="input"
          inputMode="url"
          placeholder="http://homeassistant.local:8123"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          aria-describedby="ha-address-help"
        />
        <span id="ha-address-help" className="dk-sub">
          As this server reaches it. Plain http only for home and Tailscale addresses; https otherwise.
        </span>

        <label htmlFor="ha-token" className="house-label">
          Long-lived access token
        </label>
        <input
          id="ha-token"
          className="input"
          type="password"
          autoComplete="off"
          placeholder={data?.hasToken ? 'Saved. Type a new one to change it' : 'Paste it from your Home Assistant profile'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-describedby="ha-token-help"
        />
        <span id="ha-token-help" className="dk-sub">
          Sent sealed, and kept only on this server. It's never shown again, here or anywhere.
        </span>

        <label htmlFor="ha-entity" className="house-label">
          Which list
        </label>
        {lists && lists.length > 0 ? (
          <select id="ha-entity" className="input" value={entity} onChange={(e) => setEntity(e.target.value)}>
            {!lists.some((l) => l.entity === entity) && <option value={entity}>{entity || 'Pick a list'}</option>}
            {lists.map((l) => (
              <option key={l.entity} value={l.entity}>
                {l.name ? `${l.name} (${l.entity})` : l.entity}
              </option>
            ))}
          </select>
        ) : (
          <input id="ha-entity" className="input" placeholder="todo.shopping_list" value={entity} onChange={(e) => setEntity(e.target.value)} aria-describedby="ha-entity-help" />
        )}
        <span id="ha-entity-help" className="dk-sub">
          Test connection lists your to-do lists.
        </span>

        <label className="check">
          <input type="checkbox" className="switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="grow">
            <strong>Sync the shopping list with Home Assistant</strong>
            <span className="dk-sub">{HA_SHARED}</span>
          </span>
        </label>

        {msg && (
          <p className={`banner ${msg.bad ? 'red' : 'green'} small`} role={msg.bad ? 'alert' : 'status'}>
            {msg.text}
          </p>
        )}
        <div className="dk-btns">
          <button className="btn" type="button" disabled={!!busy || !address.trim()} onClick={() => void test()}>
            {busy === 'Testing…' ? busy : 'Test connection'}
          </button>
          <button className="btn primary" type="submit" disabled={!!busy}>
            {busy === 'Saving…' ? busy : 'Save'}
          </button>
          {data?.enabled && (
            <button className="btn" type="button" disabled={!!busy} onClick={() => void syncNow()}>
              {busy === 'Syncing…' ? busy : 'Sync now'}
            </button>
          )}
        </div>
        </fieldset>
        {data?.enabled && (
          <span className="dk-sub" role="status">
            {data.blocked ? data.blocked : data.lastError ? `Last try: ${data.lastError}` : data.lastAt ? `Last synced ${timeAgo(data.lastAt)}` : 'Not synced yet'}
          </span>
        )}
      </form>
    </HousePage>
  );
}
