// 0.18.3: Server settings, a page each in the sidebar: Household, Addresses, Sign-in and security,
// Home Assistant, This browser, Updates and moving. Most changes save as they're made; Addresses
// has its own Save (a mistyped address could cut the phones off).
import { useId, useState } from 'react';
import { api3, ApiError, type HaConfig, type HouseSettings } from '../api';
import { changeHousePassphrase, confirmPassphrase, remember, session } from '../session';
import { checkPassphrase } from '../passphrase';
import { DEFAULT_PREFS, setPrefs, usePrefs } from './prefs';
import { BackupDialog, DeleteEverything } from './DataPage';
import { phonesWords } from './PhoneYes';
import { ago, ask, Card, change, Dialog, errText, Loading, LoadError, Lock, PageHead, Row, saveFile, Seg, sure, Switch, toast, useLoad } from './ui';

const GROUP = 'Server settings';
const viaPhone = () => !!session()?.viaPhone;
const PHONE_NOTE = 'Signed in with a phone: sign in with the passphrase to change this.';

/** The server's settings, loaded once per page, and a save that takes the server's answer. */
function useSettings() {
  const s = useLoad(() => api3.settings());
  const save = async (part: Partial<HouseSettings>, saved = 'Saved') => {
    const out = await change(() => api3.putSettings(part as HouseSettings), saved);
    if (out) s.set(out);
    return out;
  };
  return { ...s, save };
}

function Wait({ s }: { s: { data?: unknown; error?: string; reload: () => void } }) {
  if (s.error) return <LoadError error={s.error} onRetry={s.reload} />;
  return s.data ? null : <Loading />;
}

// ---------- Household ----------

let zoneList: string[] | undefined;
/** Every time zone this browser knows, for the Time zone box's suggestions. */
function allZones(): string[] {
  if (!zoneList) {
    try {
      zoneList = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    } catch {
      zoneList = [];
    }
  }
  return zoneList;
}

export function HouseholdPage() {
  const s = useSettings();
  const d = s.data;
  const [name, setName] = useState<string>();
  const [zone, setZone] = useState<string>();
  const ids = { name: useId(), zone: useId(), zones: useId() };
  const zones = allZones();
  const versions = d ? [...new Set([d.lowestApp ?? '0.14.0', '0.18.0', d.version ?? ''])].filter((v) => v && (!d.version || v.localeCompare(d.version, undefined, { numeric: true }) <= 0)) : [];
  return (
    <>
      <PageHead group={GROUP} title="Household" sub="The household this server belongs to, and the rules every phone on it follows." />
      <Wait s={s} />
      {d && (
        <div className="sv-grid2">
          <Card title="About">
            <form
              className="sv-field"
              onSubmit={(e) => {
                e.preventDefault();
                if (name?.trim()) void s.save({ name: name.trim() }).then(() => setName(undefined));
              }}
            >
              <label htmlFor={ids.name}>Household name</label>
              <div className="sv-row">
                <input id={ids.name} className="sv-input" value={name ?? d.name ?? ''} maxLength={60} disabled={viaPhone()} onChange={(e) => setName(e.target.value)} />
                {name !== undefined && name.trim() !== d.name && (
                  <button className="sv-btn primary" type="submit" disabled={!name.trim()}>
                    Save
                  </button>
                )}
              </div>
              <span className="sv-small">Shown on every phone's Sync screen and at the top of this page.</span>
            </form>
            <form
              className="sv-field"
              onSubmit={(e) => {
                e.preventDefault();
                if (zone?.trim()) void s.save({ timeZone: zone.trim() }, 'Time zone changed').then(() => setZone(undefined));
              }}
            >
              <label htmlFor={ids.zone}>Time zone</label>
              <div className="sv-row">
                <input id={ids.zone} className="sv-input" list={ids.zones} value={zone ?? d.timeZone ?? ''} disabled={viaPhone()} onChange={(e) => setZone(e.target.value)} />
                <datalist id={ids.zones}>
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
                {zone !== undefined && zone.trim() !== d.timeZone && (
                  <button className="sv-btn primary" type="submit">
                    Save
                  </button>
                )}
              </div>
              <span className="sv-small">
                For Activity times, the Data tab's months and weeks, and the nightly tidy-up.{' '}
                {d.timeZoneSet ? (
                  <button className="sv-btn sm" type="button" onClick={() => void s.save({ timeZone: null }, "Back to the server's own")}>
                    Use the server's own (TZ)
                  </button>
                ) : (
                  "This is the server's own (TZ)."
                )}
              </span>
            </form>
          </Card>
          <Card title="Phones on this server">
            <Row label="Oldest Restock that can join" sub="Older phones are told to update before they sync again." wrap>
              <Seg label="Oldest Restock that can join" options={versions.map((v) => ({ value: v, label: v }))} value={d.minApp ?? versions[0]} disabled={viaPhone()} onChange={(v) => void s.save({ minApp: v }, `Restock ${v} or newer from now on`)} />
            </Row>
            <div className="sv-note">
              Who's on the server, and who's an admin, is under <a href="#/phones">Phones and admins</a>.
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

// ---------- Addresses ----------

export function AddressesPage() {
  const s = useSettings();
  const d = s.data;
  const [home, setHome] = useState<string>();
  const [away, setAway] = useState<string>();
  const [error, setError] = useState<{ where?: string; text: string }>();
  const [tests, setTests] = useState<{ home?: boolean | null; away?: boolean | null }>({});
  const ids = { home: useId(), away: useId() };
  const h = home ?? d?.home ?? '';
  const a = away ?? d?.away ?? '';
  const changed = !!d && (h !== (d.home ?? '') || a !== (d.away ?? ''));
  const save = async () => {
    setError(undefined);
    try {
      const out = await api3.putSettings({ ...(home !== undefined ? { home: h } : {}), ...(away !== undefined ? { away: a } : {}) });
      s.set(out);
      setHome(undefined);
      setAway(undefined);
      toast('Addresses saved. Phones pick them up when they next sync.');
    } catch (e) {
      setError({ where: e instanceof ApiError ? e.code : undefined, text: errText(e) });
    }
  };
  const test = async () => {
    setTests({ home: h ? null : undefined, away: a ? null : undefined });
    try {
      const out = await api3.testAddresses({ ...(h ? { home: h } : {}), ...(a ? { away: a } : {}) });
      setTests({ home: h ? out.home === true : undefined, away: a ? out.away === true : undefined });
    } catch (e) {
      setTests({});
      setError({ text: errText(e) });
    }
  };
  const tag = (v: boolean | null | undefined, what: string) =>
    v === undefined ? null : v === null ? <span className="sv-tag user">Testing {what}…</span> : <span className={`sv-tag ${v ? 'ok' : 'warn'}`}>{v ? `${what} answers` : `${what} didn't answer the server`}</span>;
  return (
    <>
      <PageHead group={GROUP} title="Addresses" sub="How phones reach this server, at home and away. Phones try the home address first, for a moment, then the away one.">
        <button className="sv-btn primary" type="button" disabled={!changed || viaPhone()} onClick={() => void save()}>
          Save addresses
        </button>
      </PageHead>
      <Wait s={s} />
      {d && (
        <div className="sv-grid2">
          <Card title="Addresses">
            <div className="sv-field">
              <label htmlFor={ids.home}>At home</label>
              <input id={ids.home} className="sv-input" value={h} placeholder="http://192.168.1.20:8787" disabled={d.homeFixed || viaPhone()} aria-invalid={error?.where === 'home'} onChange={(e) => setHome(e.target.value)} />
              <span className="sv-small">{d.homeFixed ? 'Set where the server runs (RESTOCK_HOME_URL). Change it there.' : 'Your network or Tailscale. http:// is fine here.'}</span>
            </div>
            <div className="sv-field">
              <label htmlFor={ids.away}>Away from home</label>
              <input id={ids.away} className="sv-input" value={a} placeholder="https://restock.example.com" disabled={d.awayFixed || viaPhone()} aria-invalid={error?.where === 'away'} onChange={(e) => setAway(e.target.value)} />
              <span className="sv-small">{d.awayFixed ? 'Set where the server runs (RESTOCK_AWAY_URL). Change it there.' : 'A Cloudflare tunnel or your own domain. Must start with https://.'}</span>
            </div>
            {error && (
              <p className="sv-error" role="alert">
                {error.text}
              </p>
            )}
            <div className="sv-row wrap">
              {tag(tests.home, 'Home address')}
              {tag(tests.away, 'Away address')}
            </div>
            <button className="sv-btn sm" type="button" style={{ alignSelf: 'flex-start' }} disabled={!h && !a} onClick={() => void test()}>
              Test both
            </button>
            <span className="sv-small">The server tries each address itself, and checks a Restock server with this household's name answers. Away from home, your phones may still need to be on mobile data to be sure.</span>
          </Card>
          <Card title="What phones get">
            <p className="sv-small">New phones get both addresses in their QR code. Phones already on the server pick up a change the next time they sync.</p>
            <div className="sv-note">Behind a Cloudflare tunnel, the code has the away address exactly as it is here (https://), not the http:// the tunnel passes along.</div>
            <p className="sv-small">Phones don't need location or Wi-Fi permission for this: they try home first, for a moment, then away, and remember which one answered.</p>
            {!d.addrSet && <p className="sv-small">Until you save them here, the server learns them from the addresses its page is opened with.</p>}
          </Card>
        </div>
      )}
    </>
  );
}

// ---------- Sign-in and security ----------

export function SecurityPage() {
  const s = useSettings();
  const d = s.data;
  const browsers = useLoad(() => api3.browsers());
  const [changing, setChanging] = useState(false);
  const [key, setKey] = useState<string>();
  const hours = [
    { value: 1, label: '1 hour' },
    { value: 24, label: '1 day' },
    { value: 168, label: '7 days' },
    { value: 720, label: '30 days' },
  ];
  const userName = async () => {
    const next = await ask({ title: 'Change the user name', label: 'New user name', value: d?.user ?? '', action: 'Next', autoComplete: 'username' });
    if (!next?.trim() || next.trim() === d?.user) return;
    const pass = await ask({ title: 'Your passphrase', detail: 'Changing the user name needs the passphrase (and a yes on an admin phone).', label: 'Passphrase', action: 'Change it', secret: true });
    if (!pass) return;
    const out = await change(async () => api3.userName(next.trim(), await confirmPassphrase(pass)), 'User name changed');
    if (!out) return;
    const cur = session();
    if (cur) remember({ ...cur, user: out.user });
    try {
      localStorage.setItem('restock-server-user', out.user);
    } catch {
      // fine
    }
    s.reload();
  };
  const showKey = async () => {
    const pass = await ask({ title: 'Your passphrase', detail: 'Showing the recovery key needs the passphrase (and a yes on an admin phone).', label: 'Passphrase', action: 'Show it', secret: true });
    if (!pass) return;
    const r = await change(async () => api3.recovery(await confirmPassphrase(pass)), '');
    if (r?.recovery ?? r?.key) setKey(r.recovery ?? r.key);
  };
  const others = (browsers.data ?? []).filter((b) => !b.current);
  return (
    <>
      <PageHead group={GROUP} title="Sign-in and security" sub="How you sign in to this page, and the keys that protect the household." />
      <Wait s={s} />
      {d && (
        <div className="sv-grid2">
          <Card title="Passphrase and keys">
            <Row label="Passphrase" sub="Signs in here, and unlocks risky changes">
              <button className="sv-btn sm" type="button" disabled={viaPhone()} onClick={() => setChanging(true)}>
                Change…
              </button>
            </Row>
            <Row label="User name" sub={d.user ?? 'admin'}>
              <button className="sv-btn sm" type="button" disabled={viaPhone()} onClick={() => void userName()}>
                Change…
              </button>
            </Row>
            <Row label="Recovery key" sub={`For a new server if this one's lost, or if every admin phone is.${d.recoverySaved ? '' : ' Not saved yet.'}`}>
              <button className="sv-btn sm" type="button" disabled={viaPhone()} onClick={() => void showKey()}>
                Show…
              </button>
            </Row>
            <Lock>Each of these needs the passphrase and a yes on an admin phone</Lock>
            {viaPhone() && <span className="sv-small">{PHONE_NOTE}</span>}
          </Card>
          <Card title="Signing in here">
            <Switch label="Sign in by scanning with a phone" sub="An admin phone scans the code on the sign-in page. No passphrase to type." on={d.qrSignIn !== false} disabled={viaPhone()} onChange={(v) => void s.save({ qrSignIn: v })} />
            <Row label="A yes on an admin phone" sub={d.approvers?.length ? `After the passphrase, and for every risky change. Asks ${phonesWords(d.approvers)}.` : 'No admin phone is on Restock 0.18.3 yet, so the passphrase alone signs in until one is.'}>
              <span className={`sv-tag ${d.approvers?.length ? 'ok' : 'warn'}`}>{d.approvers?.length ? 'On' : 'Waiting'}</span>
            </Row>
            <Row label="Sign out after" sub="A browser left alone this long has to sign in again" wrap>
              <Seg label="Sign out after" options={hours} value={d.sessionHours ?? 720} disabled={viaPhone()} onChange={(v) => void s.save({ sessionHours: v })} />
            </Row>
          </Card>
        </div>
      )}
      <div className="sv-card sv-tbl-wrap" style={{ padding: '8px 10px' }}>
        {browsers.error && <LoadError error={browsers.error} onRetry={browsers.reload} />}
        {!browsers.data && !browsers.error && <Loading />}
        {browsers.data && (
          <table className="sv-tbl">
            <thead>
              <tr>
                <th scope="col">Signed-in browser</th>
                <th scope="col">How</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sv-skip">Sign out</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {browsers.data.map((b) => (
                <tr key={b.id}>
                  <td>
                    <b>{b.label ?? 'A browser'}</b> {b.current && <span className="sv-tag ok">This one</span>}
                  </td>
                  <td className="sv-small" data-label="How">{b.kind === 'phone' ? 'An admin phone' : 'The passphrase'}</td>
                  <td data-label="Last used">{ago(b.lastUsed)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {!b.current && (
                      <button
                        className="sv-btn sm danger"
                        type="button"
                        onClick={() =>
                          void change(() => api3.endBrowser(b.id), 'Signed out').then(() => {
                            browsers.reload();
                          })
                        }
                      >
                        Sign out
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {others.length > 1 && (
          <div className="sv-row" style={{ padding: '8px 10px', justifyContent: 'flex-end' }}>
            <button
              className="sv-btn sm"
              type="button"
              onClick={() =>
                void (async () => {
                  if (!(await sure('Sign out everywhere else?', 'Every other browser signed in to this page has to sign in again. Phones keep syncing.', 'Sign them out'))) return;
                  await change(async () => {
                    for (const b of others) await api3.endBrowser(b.id);
                  }, 'Signed out everywhere else');
                  browsers.reload();
                })()
              }
            >
              Sign out everywhere else
            </button>
          </div>
        )}
      </div>
      {changing && <PassphraseDialog onClose={() => setChanging(false)} />}
      {key && (
        <Dialog title="Your recovery key" onClose={() => setKey(undefined)}>
          <p className="sv-small" style={{ fontSize: 15 }}>
            Write it down or keep it in a password manager, away from this computer. It brings the household back on a new server, and says yes when every admin phone is lost.
          </p>
          <p className="sv-code" style={{ fontSize: 18, textAlign: 'center' }}>
            {key}
          </p>
          <div className="sv-actions">
            <button className="sv-btn" type="button" onClick={() => saveFile('restock-recovery-key.txt', `Restock server recovery key\n${key}\n`, 'text/plain')}>
              Save as a file
            </button>
            <button
              className="sv-btn primary"
              type="button"
              onClick={() => {
                void api3.recoverySaved().catch(() => undefined);
                setKey(undefined);
                s.reload();
              }}
            >
              I've saved it
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function PassphraseDialog({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ids = { a: useId(), b: useId(), c: useId() };
  const strength = next ? checkPassphrase(next, session()?.user ?? '') : undefined;
  const ok = !!cur && !!strength?.ok && next === again;
  return (
    <Dialog title="Change the passphrase" onClose={onClose}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          setBusy(true);
          setError(undefined);
          changeHousePassphrase(cur, next)
            .then(() => {
              toast('Passphrase changed. Other browsers were signed out.');
              onClose();
            })
            .catch((err: unknown) => setError(err instanceof ApiError && err.code === 'approve-cancelled' ? 'Not changed: no admin phone said yes.' : errText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="sv-field">
          <label htmlFor={ids.a}>Current passphrase</label>
          <input id={ids.a} className="sv-input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </div>
        <div className="sv-field">
          <label htmlFor={ids.b}>New passphrase</label>
          <input id={ids.b} className="sv-input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={!!next && !strength?.ok} />
          <span className="sv-small">{next && !strength?.ok ? strength?.problem : 'Four or more words you can remember is good.'}</span>
        </div>
        <div className="sv-field">
          <label htmlFor={ids.c}>The new one again</label>
          <input id={ids.c} className="sv-input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={!!again && again !== next} />
        </div>
        {error && (
          <p className="sv-error" role="alert">
            {error}
          </p>
        )}
        <div className="sv-actions">
          <button className="sv-btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="sv-btn primary" type="submit" disabled={!ok || busy}>
            {busy ? 'Changing…' : 'Change it'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- Home Assistant ----------

export function HomeAssistantPage() {
  const ha = useLoad(() => api3.homeAssistant());
  const d = ha.data;
  const [address, setAddress] = useState<string>();
  const [entity, setEntity] = useState<string>();
  const [result, setResult] = useState<string>();
  const ids = { a: useId(), e: useId() };
  const put = async (c: HaConfig & { token?: string }, saved = 'Saved') => {
    const out = await change(() => api3.putHomeAssistant(c), saved);
    if (out) {
      ha.set(out);
      setAddress(undefined);
      setEntity(undefined);
    }
  };
  const token = async () => {
    const t = await ask({ title: 'Home Assistant token', detail: 'A long-lived access token: in Home Assistant, your profile → Security → Long-lived access tokens → Create token.', label: 'Token', action: 'Save', secret: true, autoComplete: 'off' });
    if (t?.trim()) await put({ token: t.trim() }, 'Token saved');
  };
  const dirty = d && ((address !== undefined && address !== d.address) || (entity !== undefined && entity !== d.entity));
  return (
    <>
      <PageHead group={GROUP} title="Home Assistant" sub="Connect Home Assistant, so the shopping list is there too." />
      {ha.error && <LoadError error={ha.error} onRetry={ha.reload} />}
      {!d && !ha.error && <Loading />}
      {d && (
        <div className="sv-grid2">
          <Card title="Connection">
            <Switch label="Shopping list in Home Assistant" sub="Items added by voice or in Home Assistant come onto the list, and the other way." on={!!d.enabled} disabled={viaPhone()} onChange={(v) => void put({ enabled: v }, v ? 'On' : 'Off')} />
            <div className="sv-field">
              <label htmlFor={ids.a}>Home Assistant address</label>
              <input id={ids.a} className="sv-input" value={address ?? d.address ?? ''} placeholder="http://homeassistant.local:8123" disabled={viaPhone()} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div className="sv-field">
              <label htmlFor={ids.e}>Its to-do list</label>
              <input id={ids.e} className="sv-input" value={entity ?? d.entity ?? ''} placeholder="todo.shopping_list" disabled={viaPhone()} onChange={(e) => setEntity(e.target.value)} />
            </div>
            {dirty && (
              <button className="sv-btn primary" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => void put({ ...(address !== undefined ? { address } : {}), ...(entity !== undefined ? { entity } : {}) })}>
                Save
              </button>
            )}
            <div className="sv-row wrap">
              <span className={`sv-tag ${d.lastError ? 'warn' : d.lastAt ? 'ok' : 'user'}`}>{d.lastError ? 'Not working' : d.lastAt ? `Connected · ${ago(d.lastAt)}` : d.hasToken ? 'Not synced yet' : 'No token yet'}</span>
              <span className="sv-grow" />
              <button
                className="sv-btn sm"
                type="button"
                disabled={viaPhone()}
                onClick={() =>
                  void api3
                    .testHomeAssistant()
                    .then((r) => setResult(r.ok ? 'It answered, and the list is there.' : (r.message ?? "It didn't answer.")))
                    .catch((e: unknown) => setResult(errText(e)))
                }
              >
                Test
              </button>
              <button className="sv-btn sm" type="button" disabled={viaPhone()} onClick={() => void token()}>
                {d.hasToken ? 'Change the token…' : 'Add the token…'}
              </button>
            </div>
            {(result || d.lastError || d.blocked) && <p className="sv-small">{result ?? d.lastError ?? d.blocked}</p>}
          </Card>
          <Card title="What it shares">
            <p className="sv-small">Only the shopping list's items go across: their names and ticks. No prices, receipts or pantry.</p>
            {d.phone && d.phoneName && <div className="sv-note">Home Assistant was set up on {d.phoneName}. The server runs it from here on.</div>}
            <button className="sv-btn sm" type="button" style={{ alignSelf: 'flex-start' }} disabled={!d.enabled} onClick={() => void change(() => api3.syncHomeAssistant(), 'Synced with Home Assistant')}>
              Sync now
            </button>
          </Card>
        </div>
      )}
    </>
  );
}

// ---------- This browser ----------

export function BrowserPage() {
  const p = usePrefs();
  return (
    <>
      <PageHead group={GROUP} title="This browser" sub="How this page looks on this computer. Nothing here changes the phones." />
      <div className="sv-grid2">
        <Card title="Look">
          <Row label="Light or dark" wrap>
            <Seg
              label="Light or dark"
              value={p.theme}
              onChange={(theme) => setPrefs({ theme })}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' },
              ]}
            />
          </Row>
          <Row label="Style" sub="The same two as on the phones" wrap>
            <Seg
              label="Style"
              value={p.style}
              onChange={(style) => setPrefs({ style })}
              options={[
                { value: 'default', label: 'Default theme' },
                { value: 'simple', label: 'Simple' },
              ]}
            />
          </Row>
          <Row label="Text size" wrap>
            <Seg
              label="Text size"
              value={p.text}
              onChange={(text) => setPrefs({ text })}
              options={[
                { value: 'smaller', label: 'Smaller' },
                { value: 'normal', label: 'Normal' },
                { value: 'bigger', label: 'Bigger' },
              ]}
            />
          </Row>
        </Card>
        <Card title="Animations">
          <Switch label="Opening animation" sub="When this page loads, the same as on the phones" on={p.opening} onChange={(opening) => setPrefs({ opening })} />
          <Switch label="Holidays" sub="Christmas, Easter, Australia Day and the rest" on={p.holidays} onChange={(holidays) => setPrefs({ holidays })} />
          <Switch label="Movement" sub="Off: still pictures. The computer's own Reduce motion turns it off too." on={p.motion} onChange={(motion) => setPrefs({ motion })} />
          <div className="sv-row wrap">
            <button className="sv-btn sm" type="button" onClick={() => window.dispatchEvent(new Event('restock-play-opening'))}>
              Play the opening
            </button>
            <button className="sv-btn sm" type="button" onClick={() => setPrefs(DEFAULT_PREFS)}>
              Back to how it was
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}

// ---------- Updates and moving ----------

const RELEASES = 'https://github.com/d-plenty/restock-server/releases';

export function UpkeepPage() {
  const s = useSettings();
  const d = s.data;
  const [moving, setMoving] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [backup, setBackup] = useState(false);
  const u = d?.updates;
  const restart = async () => {
    if (!(await sure('Restart the server?', "It's back in a few seconds. Phones carry on, and catch up once it's back.", 'Restart'))) return;
    const ok = await change(() => api3.restart(), 'Restarting…');
    if (ok) setTimeout(() => location.reload(), 6000);
  };
  const log = async () => {
    const r = await change(() => api3.serverLog(), '');
    if (r) saveFile(`restock-server-log-${new Date().toISOString().slice(0, 10)}.txt`, r.text, 'text/plain');
  };
  return (
    <>
      <PageHead group={GROUP} title="Updates and moving" sub="Keeping the server up to date, moving it, and fixing problems." />
      <Wait s={s} />
      {d && (
        <>
          <div className="sv-grid2">
            <Card title="Updates">
              <Row label="Version" sub={u?.newer ? `Server ${d.version} · ${u.latest} is out` : `Server ${d.version}${u?.latest ? ' · up to date' : ''}${u?.checked ? `. Checked ${ago(u.checked)}.` : ''}`}>
                <a className="sv-btn sm" href={u?.url ?? RELEASES} target="_blank" rel="noreferrer">
                  Release notes
                </a>
              </Row>
              <Switch label="Check for updates" sub="Once a day, the newest version number from GitHub. Admin phones are told when there's a new one." on={d.updates?.on !== false} disabled={viaPhone()} onChange={(v) => void s.save({ updateCheck: v })} />
              <p className="sv-small">Updating is done where the server runs (Docker or Dockge): pull the new image and restart it.</p>
            </Card>
            <Card title="Troubleshooting">
              <Row label="Server log" sub="What the server did, for a bug report. No household data in it.">
                <button className="sv-btn sm" type="button" onClick={() => void log()}>
                  Download
                </button>
              </Row>
              <Row label="Restart the server" sub={d.inDocker ? "Phones carry on and catch up once it's back" : "Not in Docker: restart it where it runs."}>
                <button className="sv-btn sm" type="button" disabled={!d.inDocker || viaPhone()} onClick={() => void restart()}>
                  Restart
                </button>
              </Row>
            </Card>
          </div>
          <div className="sv-grid2">
            <Card title="Move to a new server">
              <p className="sv-small">The household, its keys and every phone's place come with it, so phones carry on without joining again.</p>
              <button className="sv-btn" type="button" style={{ alignSelf: 'flex-start' }} disabled={viaPhone()} onClick={() => setMoving(true)}>
                How to move…
              </button>
            </Card>
            <Card title="Erase this server">
              <p className="sv-small">Deletes the household, every phone's place on it and all its data. Phones keep what they have and carry on without it.</p>
              <button className="sv-btn danger" type="button" style={{ alignSelf: 'flex-start' }} disabled={viaPhone()} onClick={() => setErasing(true)}>
                Erase everything…
              </button>
              <Lock>Needs the passphrase, a yes on an admin phone, and typing DELETE EVERYTHING</Lock>
            </Card>
          </div>
        </>
      )}
      {moving && <MoveDialog onBackup={() => setBackup(true)} onClose={() => setMoving(false)} />}
      {erasing && <DeleteEverything onClose={() => setErasing(false)} />}
      {backup && <BackupDialog onClose={() => setBackup(false)} />}
    </>
  );
}

function MoveDialog({ onBackup, onClose }: { onBackup: () => void; onClose: () => void }) {
  const [name] = useState(() => `restock-server-${new Date().toISOString().slice(0, 10)}.rsb`);
  return (
    <Dialog title="Move to a new server" onClose={onClose} wide>
      <ol className="sv-small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
        <li>
          If the new server will have different addresses, put them in <a href="#/addresses">Addresses</a> first, and give the phones a day to sync, so they know where to look.
        </li>
        <li>
          Download a backup (it's sealed with a passphrase of its own).{' '}
          <button className="sv-btn sm" type="button" onClick={onBackup}>
            Download a backup…
          </button>
        </li>
        <li>
          On the new computer, in the folder with the backup, restore it into an empty volume:
          <pre className="sv-code">{`docker run --rm -it -v "$PWD":/backup -v restock-data:/data ghcr.io/d-plenty/restock-server:latest node scripts/restore.mjs /backup/${name} /data`}</pre>
        </li>
        <li>Start the new server on that volume (the same compose file), then stop this one. Phones carry on as before.</li>
      </ol>
      <div className="sv-actions">
        <button className="sv-btn primary" type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
