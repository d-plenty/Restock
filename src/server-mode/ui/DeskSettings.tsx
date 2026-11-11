// 0.9.3: Settings at desktop widths, in two parts. Household: what the web can change for the whole
// household, with what only the owner phone or each phone can change shown greyed. Phones: each
// phone's own settings, greyed, to change on that phone. Everything it reads or changes goes
// through settingsData.ts.
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { confirmAction } from '../../lib/confirm';
import { useLive } from '../../lib/useLive';
import { money } from '../../lib/units';
import type { Section } from '../../shops';
import { Icon, Sheet, TopBar, timeAgo } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { PassphraseForm } from './Gate';
import { DeskHead, WhereNote } from './deskShared';
import { BackupSheet, BranchSheet, KeepDataFor, PassphraseV3, RecoverySheet, SignOutChoices } from './DeskHouseSettings';
import { ADMIN_NOTE, canAdmin, house, saveHouseSettings, useHouseSettings } from './houseData';
import { HA_SHARED } from './ServerHomeAssistant';
import { WebSearchSwitch } from './WebShopSearch'; // 0.9.5 (web search)
import { COSTCO_WEB_NOTE } from '../../lib/costcoNotice';
import { PhoneOnlyNote } from './PhoneOnly';
import {
  categoriesData,
  downloadBrowserBackup,
  NEW_ITEM_PCTS,
  PRODUCT_ORDERS,
  removePhone,
  serverAccount,
  setTabShops,
  setTheme,
  SHOP_AROUND_MINS,
  signOutAll,
  signOutHere,
  useHouseholdSettings,
  usePhones,
  useServerVersion,
  type ChangedOn,
  type HouseholdSettings,
  type ShopsForTab,
} from './settingsData';
import type { ProductOrder } from '../../types';
// 0.9.5 (save): the household's settings and this browser's look are held until Save settings.
import { changeHousehold } from './settingsData';
import { saveDraft } from '../../lib/settingsDraft';
import { DeskSave, useDraftPart, useSettingsDraft } from '../../ui/SaveBar';

type Part = 'household' | 'phones';

/** 0.9.5 (save): household settings and this browser's look, changed but not saved yet. */
type Pending = Partial<Pick<HouseholdSettings, 'shopAroundMin' | 'listCompare' | 'newItemPct' | 'productOrder' | 'recalls' | 'theme'>>;
const pendingChanges = (h: HouseholdSettings, p: Pending) => (Object.keys(p) as (keyof Pending)[]).filter((k) => p[k] !== undefined && p[k] !== h[k]);

const WHERE: Record<Exclude<ChangedOn, 'web'>, string> = { owner: 'Change this on the owner phone', phone: 'Change this on your phone' };

/** One line of a settings card: what it is, what it's set to, and the control or where to change it. */
export function Line({ title, sub, children, greyed, htmlFor }: { title: string; sub?: ReactNode; children?: ReactNode; greyed?: boolean; htmlFor?: string }) {
  const words = (
    <>
      <strong className="dk-line-name">{title}</strong>
      {sub && <span className="dk-sub">{sub}</span>}
    </>
  );
  return (
    <div className={`dk-set${greyed ? ' greyed' : ''}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="grow">
          {words}
        </label>
      ) : (
        <span className="grow">{words}</span>
      )}
      {children}
    </div>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="dk-eyebrow" id={id}>
        {title}
      </h2>
      <section className="card flush dk-set-card" aria-labelledby={id}>
        {children}
      </section>
    </>
  );
}

function CategoriesSheet({ sections, onClose }: { sections: HouseholdSettings['categories']; onClose: () => void }) {
  const all = useLive(categoriesData.all, []);
  const [section, setSection] = useState<Section>(sections[0]?.section ?? 'pantry');
  const [name, setName] = useState('');
  const cats = (all ?? []).filter((c) => c.section === section);
  return (
    <Sheet title="Categories" onClose={onClose}>
      <p className="small">In aisle order: the shopping list's Aisle group view follows it. Changes here reach every phone.</p>
      {sections.length > 1 && (
        <div className="seg" role="group" aria-label="Which tab">
          {sections.map((s) => (
            <button key={s.section} aria-pressed={s.section === section} onClick={() => setSection(s.section)}>
              {s.title}
            </button>
          ))}
        </div>
      )}
      <div className="card flush">
        {cats.map((c, i) => (
          <div key={c.id} className="row">
            <input
              className="input"
              defaultValue={c.name}
              aria-label={`Name of the ${c.name} category`}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== c.name) void categoriesData.rename(c.id, v);
              }}
            />
            <button className="icon-btn" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => void categoriesData.swap(c, cats[i - 1])}>
              <Icon name="up" size={18} />
            </button>
            <button className="icon-btn" aria-label={`Move ${c.name} down`} disabled={i === cats.length - 1} onClick={() => void categoriesData.swap(c, cats[i + 1])}>
              <Icon name="down" size={18} />
            </button>
            <button
              className="icon-btn"
              aria-label={`Delete ${c.name}`}
              onClick={async () => {
                const ok = await confirmAction(`Delete the "${c.name}" category?`, { detail: 'Items in it move to "Other".', action: 'Delete category', danger: true });
                if (ok) await categoriesData.remove(c.id);
              }}
            >
              <Icon name="trash" size={18} />
            </button>
          </div>
        ))}
        {all && cats.length === 0 && <p className="row small">No categories on this tab yet.</p>}
      </div>
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await categoriesData.add(name.trim(), section);
          setName('');
        }}
      >
        <input className="input" placeholder="New category" aria-label="New category" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" type="submit" disabled={!name.trim()}>
          Add
        </button>
      </form>
    </Sheet>
  );
}

/** Which shops a tab uses, for the whole household (and Keg or Pharmacy on or off). */
function ShopsSheet({ tab, onClose }: { tab: ShopsForTab; onClose: () => void }) {
  const nav = useNav();
  const [picked, setPicked] = useState(() => new Set(tab.choices.filter((c) => c.picked).map((c) => c.id)));
  const [on, setOn] = useState(tab.on);
  const [busy, setBusy] = useState(false);
  const flip = (id: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(id as never)) next.delete(id as never);
      else next.add(id as never);
      return next;
    });
  const save = async () => {
    if (on && picked.size === 0) return nav.toast('Pick at least one shop, or switch the tab off.');
    setBusy(true);
    try {
      await setTabShops(
        tab.section,
        tab.choices.filter((c) => picked.has(c.id)).map((c) => c.id),
        tab.section === 'pantry' ? undefined : on,
      );
      nav.toast(`${tab.title}: saved for every phone`);
      onClose();
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={tab.title} onClose={onClose}>
      <p className="small">The shops the household uses on this tab. Each phone keeps its own branch and shop sign-ins.</p>
      {tab.section !== 'pantry' && (
        <label className="check card" style={{ flexDirection: 'row' }}>
          <input type="checkbox" className="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span className="title">The {tab.section === 'keg' ? 'Keg' : 'Health'} tab is on</span>
        </label>
      )}
      <fieldset className="card flush dk-fieldset" disabled={!on}>
        <legend className="sr-only">Shops on {tab.title}</legend>
        {tab.choices.map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" checked={picked.has(c.id)} onChange={() => flip(c.id)} />
            <span className="grow">{c.name}</span>
          </label>
        ))}
      </fieldset>
      {tab.section === 'pantry' && (
        <p className="small" style={{ margin: 0 }}>
          {COSTCO_WEB_NOTE}
        </p>
      )}
      <button className="btn primary" disabled={busy} onClick={() => void save()}>
        Save for every phone
      </button>
      <button className="btn" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

/** 0.9.4: the house's name, set here (the server signs it into the household record). */
function HouseName({ fallback }: { fallback: string }) {
  const nav = useNav();
  const { data, reload } = useHouseSettings();
  const [name, setName] = useState<string>();
  const shown = name ?? data?.name ?? fallback;
  // 0.9.5 (save): saved with Save settings.
  const dirty = name !== undefined && !!shown.trim() && shown.trim() !== data?.name;
  useDraftPart(
    {
      dirty: () => dirty,
      save: async () => {
        await saveHouseSettings({ name: shown.trim() });
        setName(undefined);
        reload();
        nav.toast('Renamed. Phones see it at their next sync.');
      },
      discard: () => setName(undefined),
    },
    [dirty, shown],
  );
  return (
    <Line title="Household name" htmlFor="dk-house-name" sub="Shown on this page and when a phone joins. Each phone can call the server what it likes.">
      <form
        className="dk-btns house-name-form"
        onSubmit={(e) => {
          e.preventDefault();
          void saveDraft();
        }}
      >
        <input id="dk-house-name" className="input dk-select house-name-input" disabled={!canAdmin()} value={shown} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </form>
    </Line>
  );
}

function HouseholdPart() {
  const nav = useNav();
  const h = useHouseholdSettings();
  const v3 = house();
  const [branches, setBranches] = useState(false);
  const [backup, setBackup] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const acct = serverAccount();
  const version = useServerVersion();
  const [cats, setCats] = useState(false);
  const [shopsFor, setShopsFor] = useState<ShopsForTab>();
  const [changing, setChanging] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [saving, setSaving] = useState(false);
  // 0.9.5 (save): changes waiting for Save settings, shown in place of what's set (hv).
  const [pend, setPend] = useState<Pending>({});
  const dirty = !!h && pendingChanges(h, pend).length > 0;
  useDraftPart(
    {
      dirty: () => dirty,
      save: async () => {
        if (!h) return;
        const { theme, ...house } = Object.fromEntries(pendingChanges(h, pend).map((k) => [k, pend[k]])) as Pending;
        const patch = {
          ...(house.shopAroundMin !== undefined ? { shopAroundMin: house.shopAroundMin } : {}),
          ...(house.newItemPct !== undefined ? { defaultThresholdPct: house.newItemPct } : {}),
          ...(house.listCompare !== undefined ? { listCompare: house.listCompare } : {}),
          ...(house.productOrder !== undefined ? { productOrder: house.productOrder } : {}),
          ...(house.recalls !== undefined ? { recallsEnabled: house.recalls } : {}),
        };
        if (Object.keys(patch).length) await changeHousehold(patch);
        if (theme) await setTheme(theme);
        setPend({});
      },
      discard: () => setPend({}),
    },
    [dirty, pend, h],
  );
  if (!h) return <div aria-busy="true" />;
  const hv = { ...h, ...pend };
  const where = (on: ChangedOn) => (on === 'web' ? null : <WhereNote>{WHERE[on]}</WhereNote>);
  const catCount = h.categories.reduce((s, c) => s + c.count, 0);
  const editable = h.settingsOn === 'web';
  // 0.9.5 (save): a change that doesn't take (not in a household yet, a value the household can't have) says why on the Save bar.
  const hold = (p: Pending) => setPend((was) => ({ ...was, ...p })); // 0.9.5 (save)
  return (
    <>
      <p className="small dk-tight">
        Household settings apply to every phone and go out with the next sync. Anything only a phone can change is shown greyed, with where to change it.
      </p>
      {!h.inHousehold && (
        <p className="banner amber small" role="note">
          This browser hasn't synced with your phones yet, so household settings can't be changed here for now.
        </p>
      )}

      {/* 0.9.8: the same groups, in the same order, as Settings on the phone. Phone-only ones are greyed, saying where. */}
      <Group id="dk-s-shops" title="Shops">
        {h.shops.map((t) => (
          <Line
            key={t.section}
            title={t.title}
            sub={t.on ? t.shops.map((s) => s.name).join(' · ') || 'None picked' : 'Switched off for the household'}
            greyed={h.shopsOn !== 'web'}
          >
            {h.shopsOn === 'web' ? (
              <button className="btn small" onClick={() => setShopsFor(t)} aria-label={`Change shops for ${t.title}`}>
                Change shops
              </button>
            ) : (
              where(h.shopsOn)
            )}
          </Line>
        ))}
        {v3 ? (
          <Line title="Which branch" sub="The household's usual branch of each shop, for phones that haven't picked their own. A phone's own pick always wins.">
            <button className="btn small" onClick={() => setBranches(true)}>
              Set branches
            </button>
          </Line>
        ) : (
          <Line title="Which branch" sub="The branch each phone shops at (its main and second branch) stays on that phone, with its sign-ins." greyed>
            {where('phone')}
          </Line>
        )}
      </Group>

      {v3 ? (
        <Group id="dk-s-household" title="Household">
          <HouseName fallback={h.name} />
          <Line title="What each phone shares" sub="Each phone chooses: Groceries (pantry and shopping list), Keg, Health, receipts, loyalty cards." greyed>
            <WhereNote>Change this on each phone</WhereNote>
          </Line>
          <Line title="Adding and removing phones" sub="This server is the household's owner.">
            <button className="btn small" onClick={() => nav.push({ name: 'server', page: 'phones' })}>
              Server and phones
            </button>
          </Line>
        </Group>
      ) : (
        <Group id="dk-s-household" title="Household">
          <Line title="Household name" sub={h.name} greyed={h.nameOn !== 'web'}>
            {where(h.nameOn)}
          </Line>
          <Line title="What the household shares" sub={h.shares} greyed>
            {where('owner')}
          </Line>
          <Line title="Owner phone, adding and removing phones" sub={h.owner} greyed>
            {where('owner')}
          </Line>
        </Group>
      )}

      {v3 ? (
        <Group id="dk-s-server" title="Your Restock server">
          <Line title="Sign-in" sub={`User name ${acct.user}${version ? ` · Restock server ${version}` : ''}${acct.viaPhone ? ' · this tab signed in with a phone' : ''}`}>
            {!acct.viaPhone && !changing && (
              <button className="btn small" onClick={() => setChanging(true)}>
                Change passphrase
              </button>
            )}
          </Line>
          {changing && (
            <PassphraseV3
              onCancel={() => setChanging(false)}
              onDone={(m) => {
                setChanging(false);
                setMsg(m);
              }}
            />
          )}
          {msg && (
            <p className="dk-set small" role="status">
              {msg}
            </p>
          )}
          <KeepDataFor Line={Line} />
          {/* 0.9.5 (web search): Let the web page search the shops (off by default). */}
          <WebSearchSwitch Line={Line} />
          {!canAdmin() && (
            <p className="dk-set small" role="note">
              {ADMIN_NOTE.replace('change this', 'change the server’s settings, back it up or see the recovery key')}
            </p>
          )}
          <Line title="Encrypted backup" sub="Everything on the server in one file, locked with a backup passphrase you choose. For a laptop or a drive, in case the server is lost.">
            <button className="btn small" disabled={!canAdmin()} onClick={() => setBackup(true)}>
              <Icon name="download" size={16} /> Download
            </button>
          </Line>
          <Line title="Recovery key" sub="If the server is lost, a phone takes the household back with it. Save it once, somewhere safe.">
            <button className="btn small" disabled={!canAdmin()} onClick={() => setRecovery(true)}>
              Show
            </button>
          </Line>
          <Line title="Home Assistant" sub={HA_SHARED}>
            <button className="btn small" onClick={() => nav.push({ name: 'homeAssistant' })}>
              Home Assistant
            </button>
          </Line>
          <Line title="Address" sub={`At home: ${location.origin}`}>
            <button className="btn small" onClick={() => nav.push({ name: 'server', page: 'phones' })}>
              Server and phones
            </button>
          </Line>
        </Group>
      ) : (
      <Group id="dk-s-server" title="Your Restock server">
        <Line title="Sign-in" sub={`User name ${acct.user}${version ? ` · Restock server ${version}` : ''}`}>
          {acct.canChangePassphrase && !changing && (
            <button className="btn small" onClick={() => setChanging(true)}>
              Change passphrase
            </button>
          )}
        </Line>
        {changing && (
          <div className="dk-set dk-set-form">
            <PassphraseForm
              user={acct.user}
              submit="Change the passphrase"
              onDone={() => {
                setChanging(false);
                setMsg('Changed. Other browsers need the new passphrase.');
                window.dispatchEvent(new CustomEvent('restock-server-session'));
              }}
            />
            <button className="btn small" onClick={() => setChanging(false)}>
              Cancel
            </button>
          </div>
        )}
        {!acct.canChangePassphrase && (
          <Line
            title="Passphrase"
            sub={acct.viaPhone ? 'Signed in with a phone: sign in with the passphrase to change it.' : 'Sign in again with the passphrase to change it.'}
            greyed
          />
        )}
        {msg && (
          <p className="dk-set small" role="status">
            {msg}
          </p>
        )}
        <Line title="Address" sub={`At home: ${location.origin}`}>
          <button className="btn small" onClick={() => nav.push({ name: 'server', page: 'phones' })}>
            Phones and browsers
          </button>
        </Line>
        <Line title="Price history" sub={h.historyText} greyed>
          {where('phone')}
        </Line>
      </Group>
      )}

      <Group id="dk-s-checks" title="Price checks">
        <Line title={'Check prices in the background'} sub={'Each phone checks at its own time (5:00 am unless changed).'} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
        <Line title={'Price check time'} sub={'Picked on each phone.'} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
      </Group>

      <Group id="dk-s-list" title="Shopping list">
        <Line title="Shop around" htmlFor="dk-shop-around" sub="Only send an item to another shop if it saves at least this much" greyed={!editable}>
          <select
            id="dk-shop-around"
            className="input dk-select"
            disabled={!editable}
            value={String(hv.shopAroundMin)}
            onChange={(e) => hold({ shopAroundMin: Number(e.target.value) })}
          >
            {SHOP_AROUND_MINS.map((v) => (
              <option key={v} value={String(v)}>
                {v === 0 ? 'Any saving' : money(v)}
              </option>
            ))}
          </select>
        </Line>
        <Line title="The list's cheapest" htmlFor="dk-compare" sub="Best value compares per 100 g, litre or item; lowest price compares the shelf price" greyed={!editable}>
          <select id="dk-compare" className="input dk-select" disabled={!editable} value={hv.listCompare} onChange={(e) => hold({ listCompare: e.target.value as 'unit' | 'price' })}>
            <option value="unit">Best value</option>
            <option value="price">Lowest price</option>
          </select>
        </Line>
        <Line title="Price alerts start at" htmlFor="dk-new-alert" sub="For new items: tell us when it's this much under its usual price" greyed={!editable}>
          <select id="dk-new-alert" className="input dk-select" disabled={!editable} value={String(hv.newItemPct)} onChange={(e) => hold({ newItemPct: Number(e.target.value) })}>
            {[...new Set([...NEW_ITEM_PCTS, h.newItemPct])]
              .sort((x, y) => x - y)
              .map((p) => (
                <option key={p} value={String(p)}>
                  {p}% off
                </option>
              ))}
          </select>
        </Line>
        <Line title="An item's products" htmlFor="dk-order" sub="The order they're listed in on an item's page" greyed={!editable}>
          <select id="dk-order" className="input dk-select" disabled={!editable} value={hv.productOrder} onChange={(e) => hold({ productOrder: e.target.value as ProductOrder })}>
            {PRODUCT_ORDERS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Line>
        <Line title="Categories" sub={`${catCount} categor${catCount === 1 ? 'y' : 'ies'}, in aisle order`}>
          <button className="btn small" onClick={() => setCats(true)}>
            Edit categories
          </button>
        </Line>
        <Line title="Recall alerts" htmlFor="dk-recalls" sub="Each phone checks daily against the official Australian recall lists" greyed={!editable}>
          <input id="dk-recalls" type="checkbox" className="switch" disabled={!editable} checked={hv.recalls} onChange={(e) => hold({ recalls: e.target.checked })} />
        </Line>
      </Group>

      <Group id="dk-s-alerts" title="Alerts">
        <Line title={'Deals and catalogue day'} sub={'Notifications are on each phone.'} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
        <Line title={'Gift card reminders'} sub={'Cards stay on each phone.'} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
      </Group>

      <Group id="dk-s-browser" title="Colours and this browser">
        <Line title="Look" sub="Just for this browser">
          <div className="dk-seg" role="group" aria-label="Look">
            {(
              [
                ['system', 'Auto'],
                ['light', 'Light'],
                ['dark', 'Dark'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} aria-pressed={hv.theme === v} onClick={() => hold({ theme: v })}>
                {label}
              </button>
            ))}
          </div>
        </Line>
        <Line
          title={v3 ? "Download this browser's copy" : 'Download a backup'}
          sub={
            v3
              ? "What this browser has, as a Restock backup file a phone can restore. Not encrypted, and no card numbers. For everything the server keeps, use Encrypted backup above."
              : "Everything this browser has, as a Restock backup file. Card numbers aren't in it: cards never go to the server."
          }
        >
          <button
            className="btn small"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await downloadBrowserBackup();
              } finally {
                setSaving(false);
              }
            }}
          >
            <Icon name="download" size={16} /> Download
          </button>
        </Line>
        {v3 ? (
          <SignOutChoices Line={Line} />
        ) : (
        <Line title="Sign out of this browser" sub="Forgets the household's keys here. Your phones aren't touched.">
          <span className="dk-btns">
            <button className="btn small danger" onClick={() => void signOutHere()}>
              Sign out
            </button>
            <button
              className="btn small"
              onClick={async () => {
                const ok = await confirmAction('Sign out every browser?', {
                  detail: 'Every browser signed in to this server, this one too. Your phones keep syncing.',
                  action: 'Sign out everywhere',
                  danger: true,
                });
                if (ok) await signOutAll();
              }}
            >
              Everywhere
            </button>
          </span>
        </Line>
        )}
      </Group>

      <Group id="dk-s-a11y" title="Accessibility">
        <Line title={'Text size and motion'} sub={"Set on each phone. This browser follows your computer's settings."} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
      </Group>

      <Group id="dk-s-receipts" title="Receipts and widgets">
        <Line title={'Receipts'} sub={'Added and read on a phone (camera).'} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
        <Line title={'Widgets'} sub={'Home screen widgets are on Android phones.'} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
      </Group>

      <Group id="dk-s-shared" title="Shared prices">
        <Line title={'Judge new items from day one'} sub={'Downloaded by each phone.'} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
      </Group>

      <Group id="dk-s-about" title="About and updates">
        <Line title={'Check for updates'} sub={'Each phone checks GitHub. This server updates with Docker or Home Assistant.'} greyed>
          <PhoneOnlyNote compact text="Set on each phone (Settings on the phone)." />
        </Line>
      </Group>
      {cats && <CategoriesSheet sections={h.categories} onClose={() => setCats(false)} />}
      {branches && <BranchSheet onClose={() => setBranches(false)} />}
      {backup && <BackupSheet onClose={() => setBackup(false)} />}
      {recovery && <RecoverySheet onClose={() => setRecovery(false)} />}
      {shopsFor && <ShopsSheet tab={shopsFor} onClose={() => setShopsFor(undefined)} />}
    </>
  );
}

function PhonesPart() {
  const { phones, error, reload } = usePhones();
  const [picked, setPicked] = useState<string>();
  const [msg, setMsg] = useState<string>();
  if (error) return <p className="banner red small">{error}</p>;
  if (!phones) return <div aria-busy="true" />;
  if (!phones.length) return <p className="small">No phones use this server yet. Add one on Household and phones.</p>;
  const p = phones.find((x) => x.device === picked) ?? phones.find((x) => x.isOwner) ?? phones[0];
  return (
    <>
      <p className="small dk-tight">Each phone keeps its own copy of these. You can see them all here; change them on that phone.</p>
      <p className="small dk-tight" role="note">
        <strong>Home Assistant:</strong>{' '}
        {house()
          ? 'runs on your server, for every phone and browser on it (Settings → Home Assistant).'
          : phones.some((x) => x.homeAssistant)
          ? `${phones.find((x) => x.homeAssistant)!.name} syncs your shopping list with it, for the whole household. To move it, turn Home Assistant on on another phone.`
          : 'No phone syncs your shopping list with it. Turn it on on one phone (Settings → Home Assistant).'}
      </p>
      <div className="dk-phone-pick" role="group" aria-label="Phone">
        {phones.map((x) => (
          <button key={x.device} aria-pressed={x === p} onClick={() => (setPicked(x.device), setMsg(undefined))}>
            <strong>{x.name}</strong>
            <span className="dk-sub">
              {[x.isOwner ? 'Owner' : undefined, x.homeAssistant ? 'Home Assistant' : undefined, x.version, x.lastSeen ? `synced ${timeAgo(x.lastSeen)}` : 'not seen yet'].filter(Boolean).join(' · ')}
            </span>
          </button>
        ))}
      </div>
      {!p.sent && (
        <p className="small dk-tight" role="note">
          {p.name} hasn't sent its settings yet. They show here once it syncs with Restock 0.9.3 or newer.
        </p>
      )}
      <div className="dk-grid">
        {p.groups.map((g) => (
          <section key={g.title} className="card dk-phone-card" aria-label={`${g.title} on ${p.name}`}>
            <h3>{g.title}</h3>
            <dl>
              {g.rows.map((r) => (
                <div key={r.label} className="dk-dl-row">
                  <dt>{r.label}</dt>
                  <dd className={p.sent ? undefined : 'dk-muted'}>{r.value}</dd>
                </div>
              ))}
            </dl>
            <WhereNote>{g.note}</WhereNote>
          </section>
        ))}
      </div>
      <section className="card dk-lost" aria-labelledby="dk-lost">
        <span className="grow">
          <strong id="dk-lost">Lost this phone?</strong>
          <span className="dk-sub">
            {house()
              ? "Remove it: it stops syncing, and the household gets a new key so it can't read anything changed from now on. Nothing it shared is deleted."
              : "Take it off the server so it can't sync here any more. The owner phone can also remove it from the household."}
          </span>
        </span>
        <button
          className="btn small danger"
          onClick={async () => {
            try {
              const done = await removePhone(p.device, {
                title: `Remove ${p.name} from this server?`,
                detail: 'It stops syncing here. To take it out of the household too, remove it on the owner phone.',
                action: 'Remove from the server',
              });
              if (!done) return;
              setMsg(`${p.name} was taken off this server.`);
              setPicked(undefined);
              reload();
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Remove from the server
        </button>
      </section>
      {msg && (
        <p className="small" role="status">
          {msg}
        </p>
      )}
    </>
  );
}

export function DeskSettings({ narrow }: { narrow?: boolean } = {}) {
  useSettingsDraft(); // 0.9.5 (save)
  const [part, setPart] = useState<Part>('household');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const parts: { id: Part; label: string }[] = [
    { id: 'household', label: 'Household' },
    { id: 'phones', label: 'Phones' },
  ];
  // Left and Right move between the two, as tabs do.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = parts.findIndex((p) => p.id === part);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? parts.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : parts.length - 1)) % parts.length;
    setPart(parts[n].id);
    tabs.current[n]?.focus();
  };
  return (
    <div className={narrow ? 'screen house-narrow' : 'dk-page dk-narrow'}>
      {narrow && <TopBar title="Settings" />}
      <DeskHead title={narrow ? '' : 'Settings'}>
        <div className="dk-seg big" role="tablist" aria-label="Settings for" onKeyDown={onKey}>
          {parts.map((p, i) => (
            <button
              key={p.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              role="tab"
              id={`dk-tab-${p.id}`}
              aria-selected={part === p.id}
              aria-controls={`dk-panel-${p.id}`}
              tabIndex={part === p.id ? 0 : -1}
              onClick={() => setPart(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {/* 0.9.5 (save): the big green Save settings, top right. */}
        <DeskSave />
      </DeskHead>
      <div role="tabpanel" id={`dk-panel-${part}`} aria-labelledby={`dk-tab-${part}`} className="dk-stack">
        {/* 0.9.5 (save): Household stays (hidden) while Phones shows, so its changes wait there. */}
        <div hidden={part !== 'household'} className="dk-stack">
          <HouseholdPart />
        </div>
        {part === 'phones' && <PhonesPart />}
      </div>
      <DeskSave foot />
    </div>
  );
}
