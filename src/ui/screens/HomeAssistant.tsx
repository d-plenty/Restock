import { useEffect, useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import {
  DEFAULT_LIST,
  getHaConfig,
  getHaStatus,
  haAvailable,
  haPhone,
  haTokenSaved,
  onHaStatus,
  phoneLabel,
  removeHaToken,
  runHaSync,
  saveHaConfig,
  saveHaToken,
  takeHomeAssistant,
  testHomeAssistant,
  tidyAddress,
  cleanToken,
  type HaHouse,
  type HaPhone,
  type HaStatus,
} from '../../lib/homeAssistant';
import { MIN_HA_VERSION, tooOld } from '../../lib/haSync';
import { agoText } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { LoadingBar, TopBar } from '../components';
import { useNav } from '../nav';
// 0.9.5 (save): the switch, the list and the address wait for Save settings; Test connection and Sync now run straight away.
import { saveFirst, stage, staged } from '../../lib/settingsDraft';
import { SaveBar, useDraftState, useSettingsDraft } from '../SaveBar';
import { webLink } from '../../lib/site';

/**
 * 0.9.4: which of the page's three states (design section 9): a phone household (or a phone on its
 * own) runs its own as in 0.9.3; in a house the server handles it, or it's to be set up there.
 */
export function pageState(who: Pick<HaPhone, 'house'>): 'phone' | 'server' | 'setUpOnServer' {
  if (!who.house) return 'phone';
  return who.house.serverRuns ? 'server' : 'setUpOnServer';
}

/** 0.9.4: in a phone household, once it's linked. */
export function NotServerWide() {
  return (
    <div className="banner grey" role="note" style={{ gap: 6 }}>
      <strong>This isn't server-wide.</strong>
      <span style={{ fontSize: 13 }}>It's just this phone and the phones paired with it.</span>
    </div>
  );
}

/** The server's page: at home, and away from home if it has an address for that. */
function ServerLinks({ house: raw }: { house: HaHouse }) {
  // 0.10.1: only a web address is a link.
  const house = { home: webLink(raw.home), away: webLink(raw.away) };
  if (!house.home && !house.away) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {house.home && (
        <a className="btn small" href={house.home} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          Open your server’s page
        </a>
      )}
      {house.away && house.away !== house.home && (
        <a className="btn small" href={house.away} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          Away from home
        </a>
      )}
    </div>
  );
}

/**
 * 0.9.4: in a house (the household's owner is a Restock server), Home Assistant runs only on the
 * server (design D12): this phone can't run its own. Either the server runs it (and this page says
 * so, with a link to the server's page, and no controls), or nobody does yet (set it up there).
 */
export function InHouse({ house, saved }: { house: HaHouse; saved: boolean }) {
  const nav = useNav();
  const server = house.name ? `your server, ${house.name}` : 'your server';
  const remove = async () => {
    const ok = await confirmAction('Remove the token from this phone?', {
      detail: "In a server household this phone doesn't use it. To stop the token working altogether, delete it in Home Assistant too (your profile → Security).",
      action: 'Remove',
    });
    if (!ok) return;
    await removeHaToken();
    nav.toast('Token removed');
  };
  return (
    <div className="screen">
      <TopBar title="Home Assistant" />
      {pageState({ house }) === 'server' ? (
        <div className="banner grey" role="status" style={{ gap: 8 }}>
          <strong>Home Assistant is handled by {server}</strong>
          <span style={{ fontSize: 13 }}>
            Every phone and browser on your server shares one Home Assistant shopping list. Your server keeps it in step all the time, so there’s
            nothing to set up on this phone. To change the address, the list or the token, use your server’s page.
          </span>
          <ServerLinks house={house} />
        </div>
      ) : (
        <div className="banner grey" role="status" style={{ gap: 8 }}>
          <strong>Set it up on your server’s page</strong>
          <span style={{ fontSize: 13 }}>
            In a server household, Home Assistant runs on your server, so every phone and browser shares one list. This phone can’t run its own.
            Open your server’s page and go to Home Assistant.
          </span>
          <ServerLinks house={house} />
        </div>
      )}
      {saved && !house.serverRuns && (
        <div className="card" style={{ gap: 8 }}>
          <span className="small">A Home Assistant token from before is still saved on this phone. It isn’t used here any more.</span>
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void remove()}>
            Remove the token
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 0.9.3: Settings → Home Assistant. The grocery list both ways with a Home Assistant to-do list,
 * straight from this phone (homeAssistant.ts). Not part of setup: not everyone has Home Assistant.
 * One phone per household does it: turning it on here when another phone does asks to move it.
 * 0.9.4: in a phone household it says it isn't server-wide; in a house, InHouse.
 */
export function HomeAssistantScreen() {
  useSettingsDraft(); // 0.9.5 (save)
  useDraftState(); // shows what's waiting to be saved (staged)
  const nav = useNav();
  const config = useLive(getHaConfig, []);
  const saved = useLive(haTokenSaved, []);
  const who = useLive(haPhone, []);
  const [status, setStatus] = useState<HaStatus>();
  const [address, setAddress] = useState<string>();
  const [token, setToken] = useState('');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState<'test' | 'sync' | 'save'>();
  const [tested, setTested] = useState<{ version?: string; lists: { id: string; name: string }[] }>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    void getHaStatus().then(setStatus);
    return onHaStatus(setStatus);
  }, []);
  useEffect(() => {
    if (config && address === undefined) setAddress(config.address);
  }, [config, address]);
  // Opening the screen with everything saved: fetch the lists for the picker, quietly.
  useEffect(() => {
    if (!config?.address || !saved || tested) return;
    void testHomeAssistant(config.address)
      .then(setTested)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.address, saved]);

  if (!config || saved === undefined || !who) return <div className="screen" />;
  if (who.house && pageState(who) !== 'phone') return <InHouse house={who.house} saved={saved} />;
  // Another phone in the household syncs with Home Assistant (this one stopped, or never started).
  const elsewhere = who.inHousehold && !!who.device && !who.mine ? phoneLabel(who.name) : undefined;
  const savedOn = config.enabled && !elsewhere;
  // 0.9.5 (save): the switch as it'll be once saved.
  const on = staged<boolean>('ha-on') ?? savedOn;
  const entityShown = staged<string>('ha-entity') ?? config.entity;

  const typedToken = saved && !changing ? undefined : token.trim();
  const tidy = tidyAddress(address ?? '');
  const canTest = !!tidy && (saved || !!typedToken) && haAvailable();

  const test = async () => {
    setProblem(undefined);
    if (!tidy) return setProblem("That doesn't look like an address. Try something like http://homeassistant.local:8123.");
    if (typedToken !== undefined && typedToken && !cleanToken(typedToken))
      return setProblem("That doesn't look like a long-lived access token. Copy the whole token from Home Assistant and paste it in again.");
    setBusy('test');
    try {
      const got = await testHomeAssistant(tidy, typedToken ? cleanToken(typedToken) : undefined);
      setTested(got);
      if (typedToken) {
        await saveHaToken(cleanToken(typedToken)!, tidy);
        setToken('');
        setChanging(false);
      }
      const entity = got.lists.some((l) => l.id === config.entity) ? config.entity : (got.lists.find((l) => l.id === DEFAULT_LIST)?.id ?? got.lists[0]?.id ?? config.entity);
      await saveHaConfig({ address: tidy, entity });
      // 0.9.5 (save): Test connection saved the address and the list, so nothing's waiting for those.
      await stage('ha-address', tidy, async () => undefined, tidy);
      await stage('ha-entity', entity, async () => undefined, entity);
      setAddress(tidy);
      if (tooOld(got.version)) setProblem(`This is Home Assistant ${got.version}. The shopping list needs ${MIN_HA_VERSION} or newer: update Home Assistant first.`);
      else if (!got.lists.length)
        setProblem("Connected, but Home Assistant has no to-do lists. Add the Shopping list integration in Home Assistant (Settings → Devices & services), then test again.");
      else nav.toast(`Connected to Home Assistant${got.version ? ` ${got.version}` : ''}`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  /** The switch (held until Save), or `now` for "Move it here". */
  const toggle = async (turnOn: boolean, rightAway = false) => {
    setProblem(undefined);
    if (!rightAway) {
      if (!turnOn) return void (await stage('ha-on', false, () => saveHaConfig({ enabled: false }), savedOn));
      if (!config.address || !saved) return setProblem('Add the address and a token, then tap Test connection first.');
    } else if (!turnOn) return void (await saveHaConfig({ enabled: false }));
    if (!config.address || !saved) return setProblem('Add the address and a token, then tap Test connection first.');
    // One phone per household: moving it here stops it on the other phone.
    const now = await haPhone();
    if (now.inHousehold && now.device && !now.mine) {
      const label = phoneLabel(now.name);
      const ok = await confirmAction(`Home Assistant syncs through ${label}. Move it to this phone?`, {
        detail: `This phone takes over, and ${label} stops syncing with Home Assistant when it next syncs with the household. Your list stays the same on both.`,
        action: 'Move it here',
        danger: false,
      });
      if (!ok) return;
    }
    const go = async () => {
      await takeHomeAssistant();
      await syncNow();
    };
    if (rightAway) await go();
    else await stage('ha-on', true, go, savedOn);
  };

  const syncNow = async () => {
    setBusy('sync');
    try {
      // 0.9.12: what's waiting for Save counts too.
      if (!(await saveFirst())) return nav.toast("Couldn't save your changes, so it didn't sync");
      const s = await runHaSync({ manual: true });
      if (s.held) nav.toast("Home Assistant's list came back empty. Restock will look again in a minute");
      else if (!s.error) nav.toast('Your list is the same in Home Assistant');
    } finally {
      setBusy(undefined);
    }
  };

  const saveAddress = async () => {
    const t = tidyAddress(address ?? '');
    if (!t) return;
    setAddress(t);
    await stage('ha-address', t, () => saveHaConfig({ address: t }), config.address);
    // Not while a new token is being typed in: Test connection saves it for this address.
    if (saved && !changing) setProblem("The token only goes to the address it was saved for. Tap Change and paste it in again for this address.");
  };

  const remove = async () => {
    const ok = await confirmAction('Remove the token?', {
      detail:
        "Restock stops syncing with Home Assistant on this phone. Both lists stay as they are. To stop the token working altogether, delete it in Home Assistant too (your profile → Security).",
      action: 'Remove',
    });
    if (!ok) return;
    await removeHaToken();
    setTested(undefined);
    nav.toast('Token removed');
  };

  const pickList = async (entity: string) => {
    await stage('ha-entity', entity, () => saveHaConfig({ entity }), config.entity);
  };

  const lists = tested?.lists.length ? tested.lists : [{ id: config.entity, name: config.entity }];

  return (
    <div className="screen">
      <TopBar title="Home Assistant" />

      {!haAvailable() && (
        <div className="banner grey">
          <strong>Home Assistant works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview everything stays in this browser.</span>
        </div>
      )}

      <div className="card" style={{ gap: 8 }}>
        <strong>Your shopping list in Home Assistant, both ways</strong>
        <span className="small">
          What you add, tick or take off in Restock shows on Home Assistant's list, and the other way round. Say "Okay Nabu, add milk to my
          shopping list" and milk is on your Restock list next time you open it.
        </span>
        <span className="small">
          If it's clearly one of your pantry items, it's added as that item. If not, it's added as "milk", with a <strong>Pick my milk</strong> button
          so you can say which one you mean.
        </span>
      </div>

      {on && <NotServerWide />}

      {elsewhere ? (
        <div className="banner amber" role="status" style={{ gap: 8 }}>
          <strong>Home Assistant syncs through {elsewhere}</strong>
          <span style={{ fontSize: 13 }}>
            One phone in your household talks to Home Assistant, and your list still comes to this phone through your household's sync.
            {saved ? ' Your token stays saved here, so this phone can take over any time.' : ''}
          </span>
          <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={!haAvailable() || !!busy} onClick={() => void toggle(true, true)}>
            Move it here
          </button>
        </div>
      ) : (
        <div className="banner grey" role="note" style={{ gap: 6 }}>
          <strong>{who.inHousehold ? 'One phone in your household syncs with Home Assistant' : 'This phone syncs with Home Assistant'}</strong>
          <span style={{ fontSize: 13 }}>
            {who.inHousehold
              ? `${on ? "It's this one. " : ''}Turning it on on another phone asks to move it there, so nothing gets added twice. Your other phones get the changes through your household's sync. These settings are only for this phone.`
              : "If you set up a household later, it stays the one phone that does, and your other phones get the changes through your household's sync."}
          </span>
        </div>
      )}

      <div className="eyebrow">Connect</div>
      <div className="card flush">
        <label className="check">
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Sync with Home Assistant
            </span>
            <span className="small">{on ? 'On for this phone' : elsewhere ? `Off here: ${elsewhere} does it` : 'Off'}</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={on}
            disabled={!haAvailable() || !!busy}
            onChange={(e) => void toggle(e.target.checked)}
            aria-label="Sync with Home Assistant"
          />
        </label>
      </div>

      <div className="card">
        <label className="field">
          <span>Home Assistant's address</span>
          <input
            className="input"
            value={address ?? ''}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="http://homeassistant.local:8123"
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => void saveAddress()}
          />
        </label>
        <span className="small" style={{ marginTop: -4 }}>
          The one you open Home Assistant with. At home that can be http://homeassistant.local:8123 or its IP address (like http://192.168.1.50:8123).
          Away from home, use an https:// address, such as your Nabu Casa one (https://….ui.nabu.casa), or a Tailscale address. Restock only uses
          plain http:// at home or on Tailscale.
        </span>

        {saved && !changing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Access token
              </span>
              <span className="small">Saved</span>
            </span>
            <button className="btn small" onClick={() => setChanging(true)}>
              Change
            </button>
            <button className="btn small" onClick={() => void remove()}>
              Remove
            </button>
          </div>
        ) : (
          <>
            <label className="field">
              <span>Long-lived access token</span>
              <input
                className="input"
                type="password"
                value={token}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <span className="small" style={{ marginTop: -4 }}>
              In Home Assistant, open your profile (your name, bottom left) → Security → Long-lived access tokens → Create token. Call it Restock,
              copy it and paste it here. It stays on this phone only, locked away, and is never synced, shown again or put in a backup.
            </span>
            {changing && (
              <button
                className="btn small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  setChanging(false);
                  setToken('');
                }}
              >
                Keep the saved token
              </button>
            )}
          </>
        )}

        <button className="btn primary" disabled={!canTest || !!busy} onClick={() => void test()}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        {busy === 'test' && <LoadingBar seconds={6} />}
        {problem && (
          <div className="banner amber" role="alert">
            {problem}
          </div>
        )}
      </div>

      <div className="eyebrow">Which list</div>
      <div className="card flush">
        <label className="check">
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Home Assistant's list
            </span>
            <span className="small">{tested ? 'Your groceries list in Restock goes here' : 'Test connection to see all your lists'}</span>
          </span>
          <select
            className="input"
            style={{ width: 'auto', maxWidth: '55%', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
            value={entityShown}
            aria-label="Home Assistant's list"
            disabled={!tested}
            onChange={(e) => void pickList(e.target.value)}
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {on && (
        <>
          <div className="eyebrow">Last synced</div>
          {status?.error ? (
            <div className="banner amber" role="alert" style={{ gap: 8 }}>
              <strong>{status.auth ? 'Home Assistant turned the token down' : "Couldn't sync with Home Assistant"}</strong>
              <span style={{ fontSize: 13 }}>{status.error}</span>
              {status.auth && <span style={{ fontSize: 13 }}>Restock has stopped trying by itself, so Home Assistant doesn't block this phone.</span>}
              <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void syncNow()}>
                {busy === 'sync' ? 'Trying…' : 'Try again'}
              </button>
            </div>
          ) : (
            <div className="card flush">
              <div className="check">
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <span className="title" style={{ fontSize: 15 }}>
                    {status?.okAt ? `Synced ${agoText(status.okAt)}` : 'Not synced yet'}
                  </span>
                  <span className="small">
                    {status?.held
                      ? "Home Assistant's list came back empty, so Restock left both lists as they are (Home Assistant may be starting up). It looks again in a minute; if it's still empty a couple of minutes later, the lines it shared come off Restock's list too."
                      : 'While Restock is open: when you open it, every minute, and just after the list changes. With Restock closed: about every 15 minutes.'}
                  </span>
                </span>
                <button className="btn small" disabled={!!busy} onClick={() => void syncNow()}>
                  {busy === 'sync' ? 'Syncing…' : 'Sync now'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <div className="eyebrow">Good to know</div>
      <div className="card" style={{ gap: 8 }}>
        <span className="small">
          <strong>Voice adds come in within about 15 minutes.</strong> Restock talks to Home Assistant every minute while it's open, and about
          every 15 minutes in the background when it isn't (Android decides exactly when), so something you add by voice comes onto your Restock
          list, and your other phones, even with Restock closed.
        </span>
        <span className="small">
          <strong>Only the groceries list.</strong> Keg and Health lists stay in Restock. Something new goes across
          while it's still to buy, and ticking off works both ways.
        </span>
        <span className="small">
          <strong>Needs Home Assistant {MIN_HA_VERSION} or newer</strong>, with a to-do list such as the Shopping list integration (it's{' '}
          {DEFAULT_LIST} unless you pick another).
        </span>
        <span className="small">
          <strong>What goes to Home Assistant:</strong> your groceries list's lines (their names and how many) and which are ticked. Nothing else, and
          nothing goes anywhere but your Home Assistant.
        </span>
      </div>
      <SaveBar />
    </div>
  );
}

