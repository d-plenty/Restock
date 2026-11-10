import { describe, expect, it } from 'vitest';
import { emptyState, HaError, haProblem, restApi, syncRound, tooOld, type HaApi, type HaItem, type HaState, type Line, type Store } from './haSync';
import { matchKey } from './haMatch';

// 0.9.3: the shopping list both ways with Home Assistant, against a pretend Home Assistant.

class FakeHa implements HaApi {
  list: HaItem[] = [];
  n = 0;
  calls: string[] = [];
  /** Throw on the nth add (after adding it, as when the answer is lost on the way back). */
  failAddAfter?: number;
  adds = 0;
  async items() {
    this.calls.push('items');
    return this.list.map((i) => ({ ...i }));
  }
  async add(summary: string) {
    this.calls.push(`add ${summary}`);
    this.list.push({ uid: `u${++this.n}`, summary, status: 'needs_action' });
    if (this.failAddAfter !== undefined && ++this.adds >= this.failAddAfter) {
      this.failAddAfter = undefined;
      throw new HaError('The connection to Home Assistant broke off.');
    }
  }
  async update(uid: string, patch: { rename?: string; status?: HaItem['status'] }) {
    this.calls.push(`update ${uid} ${JSON.stringify(patch)}`);
    const i = this.list.find((x) => x.uid === uid);
    if (!i) throw new HaError('no such item');
    if (patch.rename !== undefined) i.summary = patch.rename;
    if (patch.status) i.status = patch.status;
  }
  async remove(uids: string[]) {
    this.calls.push(`remove ${uids.join(',')}`);
    this.list = this.list.filter((i) => !uids.includes(i.uid));
  }
  seed(summary: string, status: HaItem['status'] = 'needs_action') {
    this.list.push({ uid: `u${++this.n}`, summary, status });
  }
  summaries() {
    return this.list.map((i) => `${i.summary}${i.status === 'completed' ? ' ✓' : ''}`).sort();
  }
}

class MemStore implements Store {
  list: Line[] = [];
  pantry: { id: string; name: string }[] = [];
  alias: Record<string, string> = {};
  state: HaState = emptyState();
  n = 0;
  async lines() {
    return this.list.map((l) => ({ ...l }));
  }
  async items() {
    return this.pantry;
  }
  async aliases() {
    return this.alias;
  }
  async addLine(l: Omit<Line, 'id'>) {
    const id = `r${++this.n}`;
    this.list.push({ id, ...l });
    return id;
  }
  async updateLine(id: string, patch: Partial<Omit<Line, 'id'>>) {
    Object.assign(this.list.find((l) => l.id === id)!, patch);
  }
  async removeLines(ids: string[]) {
    this.list = this.list.filter((l) => !ids.includes(l.id));
  }
  async loadState() {
    return structuredClone(this.state);
  }
  async saveState(s: HaState) {
    this.state = structuredClone(s);
  }
  line(text: string, more: Partial<Line> = {}) {
    const l: Line = { id: `r${++this.n}`, text, qty: 1, checked: false, ...more };
    this.list.push(l);
    return l;
  }
  texts() {
    const names = new Map(this.pantry.map((p) => [p.id, p.name]));
    return this.list.map((l) => `${l.qty > 1 ? `${l.qty} × ` : ''}${(l.groupId && names.get(l.groupId)) || l.text}${l.groupId ? ' [item]' : ''}${l.checked ? ' ✓' : ''}`).sort();
  }
}

const setup = () => {
  const ha = new FakeHa();
  const store = new MemStore();
  store.pantry = [
    { id: 'g-milk', name: 'Milk' },
    { id: 'g-bread1', name: 'Bread' },
    { id: 'g-bread2', name: 'bread' },
    { id: 'g-eggs', name: 'Eggs' },
  ];
  return { ha, store, round: () => syncRound(ha, store) };
};

describe('voice adds from Home Assistant', () => {
  it('links a line to the one pantry item it matches', async () => {
    const { ha, store, round } = setup();
    ha.seed('milk');
    ha.seed('2 eggs');
    await round();
    expect(store.texts()).toEqual(['2 × Eggs [item]', 'Milk [item]']);
    // Home Assistant's words stay as they were said: nothing to rename.
    expect(ha.summaries()).toEqual(['2 eggs', 'milk']);
    await round();
    expect(ha.calls.filter((c) => !c.startsWith('items'))).toEqual([]);
  });

  it('adds plain words when there is no match or more than one (they show "Pick my …": listPicks.ts)', async () => {
    const { ha, store, round } = setup();
    ha.seed('oat milk');
    ha.seed('bread');
    await round();
    expect(store.texts()).toEqual(['bread', 'oat milk']);
    expect(store.list.every((l) => !l.groupId)).toBe(true);
  });

  it('uses a saved alias straight away', async () => {
    const { ha, store, round } = setup();
    store.alias = { [matchKey('bread')]: 'g-bread2' };
    ha.seed('Bread');
    await round();
    expect(store.list[0]).toMatchObject({ groupId: 'g-bread2', text: 'bread' });
  });

  it("doesn't bring across what's already ticked off in Home Assistant", async () => {
    const { ha, store, round } = setup();
    ha.seed('milk', 'completed');
    await round();
    expect(store.list).toEqual([]);
  });
});

describe('both ways', () => {
  it('ticks in Home Assistant tick in Restock, and the other way round', async () => {
    const { ha, store, round } = setup();
    ha.seed('milk');
    await round();
    ha.list[0].status = 'completed';
    await round();
    expect(store.texts()).toEqual(['Milk [item] ✓']);
    await store.updateLine(store.list[0].id, { checked: false });
    await round();
    expect(ha.summaries()).toEqual(['milk']);
  });

  it('removes on the other side what was removed on one', async () => {
    const { ha, store, round } = setup();
    const a = store.line('apples');
    store.line('pears');
    ha.seed('milk');
    await round();
    expect(ha.summaries()).toEqual(['apples', 'milk', 'pears']);
    // Removed in Restock.
    await store.removeLines([a.id]);
    await round();
    expect(ha.summaries()).toEqual(['milk', 'pears']);
    // Removed in Home Assistant.
    ha.list = ha.list.filter((i) => i.summary !== 'milk');
    await round();
    expect(store.texts()).toEqual(['pears']);
  });

  it('doesn’t bring back onto Restock’s list what it has just taken off Home Assistant’s', async () => {
    const { ha, store, round } = setup();
    const a = store.line('apples');
    store.line('pears');
    await round();
    await store.removeLines([a.id]);
    await round();
    expect(ha.summaries()).toEqual(['pears']);
    expect(store.texts()).toEqual(['pears']);
    await round();
    expect(store.texts()).toEqual(['pears']);
  });

  it('keeps something removed on one side if the other changed it since', async () => {
    const { ha, store, round } = setup();
    const a = store.line('apples');
    await round();
    await store.removeLines([a.id]);
    ha.list[0].status = 'completed';
    await round();
    expect(ha.summaries()).toEqual(['apples ✓']);
  });

  it('sends Restock’s new lines with a readable name, and renames when the item is renamed', async () => {
    const { ha, store, round } = setup();
    store.line('Milk', { groupId: 'g-milk', qty: 2 });
    store.line('Eggs', { groupId: 'g-eggs', checked: true });
    await round();
    // Ticked-off lines stay in Restock until they're on both lists.
    expect(ha.summaries()).toEqual(['2 × Milk']);
    store.pantry[0].name = 'Full cream milk';
    await round();
    expect(ha.summaries()).toEqual(['2 × Full cream milk']);
    await store.updateLine(store.list[0].id, { qty: 3 });
    await round();
    expect(ha.summaries()).toEqual(['3 × Full cream milk']);
  });

  it('takes a rename in Home Assistant as the words of a plain line', async () => {
    const { ha, store, round } = setup();
    ha.seed('oat milk');
    await round();
    ha.list[0].summary = '2 almond milk';
    await round();
    expect(store.texts()).toEqual(['2 × almond milk']);
    // …and doesn't rename it back.
    expect(ha.summaries()).toEqual(['2 almond milk']);
  });

  it('keeps a linked line’s pantry name, but takes a new number', async () => {
    const { ha, store, round } = setup();
    ha.seed('milk');
    await round();
    ha.list[0].summary = '3 x milk';
    await round();
    expect(store.texts()).toEqual(['3 × Milk [item]']);
    ha.list[0].summary = 'chocolate';
    await round();
    expect(store.texts()).toEqual(['3 × Milk [item]']);
    expect(ha.summaries()).toEqual(['3 × Milk']);
  });
});

describe('the first time, and when something goes wrong', () => {
  it('pairs what is already on both lists by its words instead of doubling it', async () => {
    const { ha, store, round } = setup();
    store.line('Milk', { groupId: 'g-milk' });
    store.line('bananas');
    store.line('Eggs', { groupId: 'g-eggs', checked: true });
    ha.seed('milk');
    ha.seed('Banana');
    ha.seed('eggs', 'completed');
    ha.seed('tea');
    await round();
    expect(ha.summaries()).toEqual(['Banana', 'eggs ✓', 'milk', 'tea']);
    expect(store.texts()).toEqual(['Eggs [item] ✓', 'Milk [item]', 'bananas', 'tea']);
    expect(store.state.pairs).toHaveLength(4);
    await round();
    expect(ha.list).toHaveLength(4);
    expect(store.list).toHaveLength(4);
  });

  it('still to buy on either side means still to buy on both, the first time', async () => {
    const { ha, store, round } = setup();
    store.line('Milk', { groupId: 'g-milk', checked: true });
    ha.seed('milk');
    ha.seed('tea', 'completed');
    store.line('tea');
    await round();
    expect(store.texts()).toEqual(['Milk [item]', 'tea']);
    expect(ha.summaries()).toEqual(['milk', 'tea']);
  });

  it('never adds anything twice when a round stops part-way', async () => {
    const { ha, store, round } = setup();
    for (const t of ['apples', 'pears', 'plums', 'figs']) store.line(t);
    ha.failAddAfter = 2;
    await expect(round()).rejects.toThrow('broke off');
    expect(ha.list).toHaveLength(2);
    await round();
    expect(ha.summaries()).toEqual(['apples', 'figs', 'pears', 'plums']);
    await round();
    expect(ha.list).toHaveLength(4);
    expect(store.list).toHaveLength(4);
    expect(store.state.pairs).toHaveLength(4);
  });

  it('never doubles lines in other alphabets, or with no letters at all', async () => {
    const { ha, store, round } = setup();
    store.line('Молоко');
    store.line('牛奶', { qty: 2 });
    store.line('🍌');
    ha.seed('Хлеб');
    for (let i = 0; i < 4; i++) await round();
    expect(ha.summaries()).toEqual(['2 × 牛奶', 'Молоко', 'Хлеб', '🍌'].sort());
    expect(store.texts()).toEqual(['2 × 牛奶', 'Молоко', 'Хлеб', '🍌'].sort());
    expect(store.state.pairs).toHaveLength(4);
    // …and different words in another alphabet aren't taken for one another.
    store.line('Кефир 2%');
    store.line('Молоко 2%');
    await round();
    await round();
    expect(ha.list).toHaveLength(6);
    expect(store.list).toHaveLength(6);
  });

  it('loses nothing when Home Assistant fails in the middle of the paired lines', async () => {
    const { ha, store, round } = setup();
    store.line('apples');
    store.line('pears');
    await round();
    // Both change in Restock, and the first change can't be sent.
    await store.updateLine(store.list[0].id, { checked: true });
    await store.updateLine(store.list[1].id, { checked: true });
    const update = ha.update.bind(ha);
    let once = true;
    ha.update = async (uid, patch) => {
      if (once) {
        once = false;
        throw new HaError('Home Assistant had a problem (500).');
      }
      return update(uid, patch);
    };
    await expect(round()).rejects.toThrow('500');
    await round();
    expect(ha.summaries()).toEqual(['apples ✓', 'pears ✓']);
  });
});

describe('the safety catch: an empty list from Home Assistant', () => {
  const MIN = 60_000;
  /** Three lines on both lists, paired, at t0. */
  const paired = async () => {
    const s = setup();
    s.store.line('apples');
    s.store.line('Milk', { groupId: 'g-milk' });
    s.ha.seed('bread');
    const t0 = 1_000_000_000;
    await syncRound(s.ha, s.store, t0);
    expect(s.store.texts()).toEqual(['Milk [item]', 'apples', 'bread']);
    expect(s.ha.summaries()).toEqual(['Milk', 'apples', 'bread']);
    expect(s.store.state.pairs).toHaveLength(3);
    s.ha.calls = [];
    return { ...s, t0 };
  };

  it('holds while Home Assistant is starting up, then carries on when the items come back', async () => {
    const { ha, store, t0 } = await paired();
    const all = ha.list;
    const snapshot = structuredClone(store.state.pairs);
    ha.list = []; // Home Assistant restarting: its list answers empty for a while
    expect(await syncRound(ha, store, t0 + MIN)).toMatchObject({ held: true, came: 0, went: 0 });
    expect(await syncRound(ha, store, t0 + 2 * MIN - 1)).toMatchObject({ held: true });
    expect(store.texts()).toEqual(['Milk [item]', 'apples', 'bread']);
    expect(store.state.pairs).toEqual(snapshot); // no snapshot update
    expect(ha.calls.filter((c) => c !== 'items')).toEqual([]); // no re-adds
    ha.list = all; // back
    const r = await syncRound(ha, store, t0 + 3 * MIN);
    expect(r.held).toBeFalsy();
    expect(store.texts()).toEqual(['Milk [item]', 'apples', 'bread']);
    expect(ha.summaries()).toEqual(['Milk', 'apples', 'bread']);
    expect(ha.calls.filter((c) => c !== 'items')).toEqual([]);
    expect(store.state.emptySince).toBeUndefined();
    // A later empty list starts a fresh hold (the old note was forgotten).
    ha.list = [];
    expect(await syncRound(ha, store, t0 + 60 * MIN)).toMatchObject({ held: true });
    expect(store.texts()).toHaveLength(3);
  });

  it("doesn't let two empty looks hours apart confirm each other (Restock closed in between)", async () => {
    const { ha, store, t0 } = await paired();
    const before = store.texts();
    ha.list = [];
    expect(await syncRound(ha, store, t0 + MIN)).toMatchObject({ held: true });
    // Restock closed; opened 3 hours later while Home Assistant is restarting again.
    expect(await syncRound(ha, store, t0 + 180 * MIN)).toMatchObject({ held: true });
    expect(store.texts()).toEqual(before);
    expect(store.state.emptySince).toBe(t0 + 180 * MIN);
    // Looks close together still confirm a real clear.
    expect(await syncRound(ha, store, t0 + 181 * MIN)).toMatchObject({ held: true });
    expect((await syncRound(ha, store, t0 + 183 * MIN)).held).toBeFalsy();
    expect(store.texts()).toEqual([]);
  });

  it('clears the paired lines when a second look 2 minutes later still finds it empty', async () => {
    const { ha, store, t0 } = await paired();
    // Changed here since the last round: that one stays (and goes back to Home Assistant).
    const apples = store.list.find((l) => l.text === 'apples')!;
    ha.list = [];
    expect(await syncRound(ha, store, t0 + MIN)).toMatchObject({ held: true });
    await store.updateLine(apples.id, { qty: 3 });
    expect(await syncRound(ha, store, t0 + 2 * MIN)).toMatchObject({ held: true }); // only 1 minute on
    const r = await syncRound(ha, store, t0 + 3 * MIN);
    expect(r.held).toBeFalsy();
    expect(store.texts()).toEqual(['3 × apples']);
    expect(ha.summaries()).toEqual(['3 × apples']);
    expect(store.state.emptySince).toBeUndefined();
    // And it's settled: nothing more either way.
    ha.calls = [];
    await syncRound(ha, store, t0 + 4 * MIN);
    expect(ha.calls).toEqual(['items']);
    expect(store.texts()).toEqual(['3 × apples']);
  });

  it('an add in Restock during the hold goes across once, whichever way the hold ends', async () => {
    for (const comesBack of [true, false]) {
      const { ha, store, t0 } = await paired();
      const all = ha.list;
      ha.list = [];
      await syncRound(ha, store, t0 + MIN);
      store.line('pears');
      expect(await syncRound(ha, store, t0 + MIN + 30_000)).toMatchObject({ held: true });
      expect(ha.calls.filter((c) => c.startsWith('add'))).toEqual([]);
      if (comesBack) ha.list = all;
      await syncRound(ha, store, t0 + 4 * MIN);
      await syncRound(ha, store, t0 + 5 * MIN);
      expect(ha.calls.filter((c) => c.startsWith('add'))).toEqual(['add pears']);
      expect(ha.summaries()).toEqual(comesBack ? ['Milk', 'apples', 'bread', 'pears'] : ['pears']);
      expect(store.texts()).toEqual(comesBack ? ['Milk [item]', 'apples', 'bread', 'pears'] : ['pears']);
    }
  });

  it('an add in Home Assistant during the hold: the list isn’t empty any more, so it carries on', async () => {
    for (const comesBack of [true, false]) {
      const { ha, store, t0 } = await paired();
      const all = ha.list;
      ha.list = [];
      await syncRound(ha, store, t0 + MIN);
      // "Okay Nabu, add eggs": with the list loaded again, or added to a list that really was emptied.
      if (comesBack) ha.list = all;
      ha.seed('eggs');
      const r = await syncRound(ha, store, t0 + MIN + 30_000);
      expect(r.held).toBeFalsy();
      await syncRound(ha, store, t0 + 2 * MIN);
      expect(store.texts()).toEqual(comesBack ? ['Eggs [item]', 'Milk [item]', 'apples', 'bread'] : ['Eggs [item]']);
      expect(ha.summaries()).toEqual(comesBack ? ['Milk', 'apples', 'bread', 'eggs'] : ['eggs']);
      expect(ha.calls.filter((c) => c.startsWith('add'))).toEqual([]);
    }
  });

  it('an empty list with nothing paired, or only lines already gone from Restock, is just empty', async () => {
    const { ha, store, round } = setup();
    expect((await round()).held).toBeFalsy();
    const a = store.line('apples');
    await round();
    await store.removeLines([a.id]);
    ha.list = [];
    expect((await round()).held).toBeFalsy();
    expect(store.state.pairs).toEqual([]);
  });
});

describe('talking to Home Assistant', () => {
  it('reads the list from service_response, and sends uids', async () => {
    const sent: { method: string; path: string; body: unknown }[] = [];
    const api = restApi(async (method, path, body) => {
      sent.push({ method, path, body });
      if (path.includes('get_items'))
        return {
          status: 200,
          text: JSON.stringify({
            changed_states: [],
            service_response: { 'todo.shopping_list': { items: [{ uid: 'a', summary: 'milk', status: 'needs_action' }, { summary: 'no uid' }] } },
          }),
        };
      return { status: 200, text: '[]' };
    }, 'todo.shopping_list');
    expect(await api.items()).toEqual([{ uid: 'a', summary: 'milk', status: 'needs_action' }]);
    await api.update('a', { status: 'completed' });
    await api.remove(['a']);
    await api.add('bread');
    expect(sent.map((s) => s.path)).toEqual([
      '/api/services/todo/get_items?return_response',
      '/api/services/todo/update_item',
      '/api/services/todo/remove_item',
      '/api/services/todo/add_item',
    ]);
    expect(sent[1].body).toEqual({ entity_id: 'todo.shopping_list', item: 'a', status: 'completed' });
    expect(sent[2].body).toEqual({ entity_id: 'todo.shopping_list', item: ['a'] });
    expect(sent[3].body).toEqual({ entity_id: 'todo.shopping_list', item: 'bread' });
  });

  it('says plainly what went wrong', () => {
    expect(haProblem(401, '401: Unauthorized', 'read the list').auth).toBe(true);
    expect(haProblem(401, '', 'x').message).toMatch(/didn't accept the token/);
    expect(haProblem(400, 'Service call requires responses but caller did not ask for responses', 'read the list', 'todo.x').message).toMatch(/2024\.8 or newer/);
    expect(haProblem(400, 'whatever', 'read the list', 'todo.x').message).toMatch(/couldn't find the list todo\.x/);
    // An item gone from the list since Restock read it isn't the list gone.
    expect(haProblem(400, '{"message":"Unable to find to-do list item: u1"}', 'change the list', 'todo.x').message).toMatch(/changed in Home Assistant while/);
    expect(haProblem(404, '', 'x').message).toMatch(/doesn't look like Home Assistant/);
    expect(haProblem(502, '', 'x').message).toMatch(/had a problem \(502\)/);
  });

  it('knows which versions are too old', () => {
    expect(tooOld('2024.7.4')).toBe(true);
    expect(tooOld('2023.12.0')).toBe(true);
    expect(tooOld('2024.8.0')).toBe(false);
    expect(tooOld('2026.11.1')).toBe(false);
    expect(tooOld(undefined)).toBe(false);
  });
});
