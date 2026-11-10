import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyState, HaError, haLineId, syncRound, type HaApi, type HaItem, type HaState, type Line, type Store } from './haSync';
import { candidates, lineSummary, matchKey, parseLine, type NamedItem } from './haMatch';

// 0.9.4: Home Assistant's round on shared fixtures (tools/sync-test/ha-fixtures.json). This side runs
// them through haSync.ts and haMatch.ts, the reference, and checks the answers kept in the file's
// `expect`; HaSyncTest.java runs the same fixtures through HaSync.java and HaMatch.java and checks
// the same `expect` (tools/sync-test/ha-parity.sh). After a deliberate change to haSync.ts:
//   HA_FIXTURES_WRITE=1 npx vitest run src/lib/haParity.test.ts
// writes the new answers, and the Java side must be changed to match.

const FILE = 'tools/sync-test/ha-fixtures.json';

type Step = Record<string, unknown> & { op: string };
interface Scenario {
  name: string;
  entity?: string;
  pantry?: NamedItem[];
  aliases?: Record<string, string>;
  steps: Step[];
}
interface Fixtures {
  about: string;
  pantry: NamedItem[];
  words: string[];
  wordAliases: Record<string, string>;
  scenarios: Scenario[];
  expect?: { words: unknown[]; scenarios: Record<string, unknown[]> };
}

/** A pretend Home Assistant (as haSync.test.ts), with what each round asked of it. */
class FakeHa implements HaApi {
  list: HaItem[] = [];
  aside?: HaItem[];
  n = 0;
  calls: string[] = [];
  failAddAfter?: number;
  adds = 0;
  failUpdateOnce = false;
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
    if (this.failUpdateOnce) {
      this.failUpdateOnce = false;
      throw new HaError('Home Assistant had a problem (500).');
    }
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
}

/** Restock's side as the real stores do it: haLineId for a line from an item, INSERT OR IGNORE. */
class MemStore implements Store {
  state: HaState = emptyState();
  n = 0;
  constructor(
    readonly shared: { list: Line[] },
    readonly pantry: NamedItem[],
    readonly alias: Record<string, string>,
    readonly entity: string,
    readonly prefix: string,
  ) {}
  async lines() {
    return this.shared.list.map((l) => ({ ...l }));
  }
  async items() {
    return this.pantry.map((p) => ({ ...p }));
  }
  async aliases() {
    return { ...this.alias };
  }
  async addLine(l: Omit<Line, 'id'>, uid?: string) {
    const id = uid ? haLineId(this.entity, uid) : `${this.prefix}${++this.n}`;
    if (!this.shared.list.some((x) => x.id === id)) this.shared.list.push({ id, ...l });
    return id;
  }
  async updateLine(id: string, patch: Partial<Omit<Line, 'id'>>) {
    Object.assign(this.shared.list.find((l) => l.id === id)!, patch);
  }
  async removeLines(ids: string[]) {
    this.shared.list = this.shared.list.filter((l) => !ids.includes(l.id));
  }
  async loadState() {
    return structuredClone(this.state);
  }
  async saveState(s: HaState) {
    this.state = structuredClone(s);
  }
}

const stateOf = (s: HaState) => ({
  pairs: s.pairs.map((p) => [p.id, p.uid, p.r.s, p.r.c, p.h.s, p.h.c]),
  pick: s.pick,
  emptySince: s.emptySince ?? null,
  emptyLast: s.emptyLast ?? null,
});

/** One scenario, and what each round gave: its answer (or error), the calls, both lists and the pairing. */
async function run(f: Fixtures, sc: Scenario): Promise<unknown[]> {
  const entity = sc.entity ?? 'todo.shopping_list';
  const pantry = (sc.pantry ?? f.pantry).map((p) => ({ ...p }));
  const shared = { list: [] as Line[] };
  const stores: Record<string, MemStore> = {
    a: new MemStore(shared, pantry, sc.aliases ?? {}, entity, 'r'),
    b: new MemStore(shared, pantry, sc.aliases ?? {}, entity, 's'),
  };
  const ha = new FakeHa();
  const out: unknown[] = [];
  const find = (s: Step) => shared.list.find((l) => (s.id !== undefined ? l.id === s.id : l.text === s.text))!;
  let rounds = 0;
  for (const s of sc.steps) {
    switch (s.op) {
      case 'seed':
        ha.list.push({ uid: `u${++ha.n}`, summary: s.summary as string, status: (s.status as HaItem['status']) ?? 'needs_action' });
        break;
      case 'haPush':
        ha.list.push({ uid: s.uid as string, summary: s.summary as string, status: (s.status as HaItem['status']) ?? 'needs_action' });
        break;
      case 'haSet': {
        const i = ha.list.find((x) => x.uid === s.uid)!;
        if (s.summary !== undefined) i.summary = s.summary as string;
        if (s.status !== undefined) i.status = s.status as HaItem['status'];
        break;
      }
      case 'haRemove':
        ha.list = ha.list.filter((i) => i.uid !== s.uid);
        break;
      case 'haSwapOut':
        ha.aside = ha.list;
        ha.list = [];
        break;
      case 'haSwapIn':
        ha.list = ha.aside!;
        break;
      case 'failAddAfter':
        ha.failAddAfter = s.n as number;
        break;
      case 'failUpdateOnce':
        ha.failUpdateOnce = true;
        break;
      case 'line': {
        const a = stores.a;
        const id = s.id !== undefined ? (s.id as string) : s.idOf !== undefined ? haLineId(entity, s.idOf as string) : `r${++a.n}`;
        const l: Line = { id, text: s.text as string, qty: (s.qty as number) ?? 1, checked: (s.checked as boolean) ?? false };
        if (s.groupId !== undefined) l.groupId = s.groupId as string;
        if (s.section !== undefined) l.section = s.section as Line['section'];
        shared.list.push(l);
        break;
      }
      case 'update':
        Object.assign(find(s), s.patch as Partial<Line>);
        break;
      case 'remove': {
        const l = find(s);
        shared.list = shared.list.filter((x) => x !== l);
        break;
      }
      case 'rename':
        pantry.find((p) => p.id === s.groupId)!.name = s.name as string;
        break;
      case 'state':
        stores.a.state = {
          pairs: (s.pairs as { idOf?: string; id?: string; uid: string; r: { s: string; c: boolean }; h: { s: string; c: boolean } }[]).map((p) => ({
            id: p.idOf !== undefined ? haLineId(entity, p.idOf) : p.id!,
            uid: p.uid,
            r: { ...p.r },
            h: { ...p.h },
          })),
          pick: [],
        };
        break;
      case 'round': {
        const store = stores[(s.store as string) ?? 'a'];
        const now = (s.now as number) ?? 1_700_000_000_000 + rounds * 60_000;
        rounds++;
        ha.calls = [];
        let r: unknown;
        try {
          const got = await syncRound(ha, store, now);
          r = { came: got.came, went: got.went, held: !!got.held };
        } catch (e) {
          r = { error: (e as Error).message };
        }
        out.push({
          r,
          calls: ha.calls,
          ha: ha.list.map((i) => [i.uid, i.summary, i.status]),
          // 0.9.5: and the list a line went on (General for what matched nothing).
          lines: shared.list.map((l) => [l.id, l.text, l.qty, l.checked, l.groupId ?? null, l.section ?? null]),
          state: stateOf(store.state),
        });
        break;
      }
      default:
        throw new Error(`no such step ${s.op}`);
    }
  }
  return out;
}

/** The words: matchKey, parseLine, lineSummary and candidates, for each. */
function words(f: Fixtures): unknown[] {
  return f.words.map((w) => {
    const p = parseLine(w);
    return {
      w,
      key: matchKey(w),
      parsed: [p.qty, p.name, p.key],
      summary: [lineSummary(w, 1), lineSummary(w, 3)],
      candidates: candidates(w, f.pantry, f.wordAliases).map((i) => i.id),
    };
  });
}

const fixtures = JSON.parse(readFileSync(FILE, 'utf8')) as Fixtures;

describe('Home Assistant fixtures shared with HaSync.java (0.9.4)', async () => {
  const got = { words: words(fixtures), scenarios: {} as Record<string, unknown[]> };
  for (const sc of fixtures.scenarios) got.scenarios[sc.name] = await run(fixtures, sc);

  if (process.env.HA_FIXTURES_WRITE) {
    writeFileSync(FILE, JSON.stringify({ ...fixtures, expect: got }, null, 1) + '\n');
  }

  it('has answers for every fixture', () => {
    expect(fixtures.expect, `Run HA_FIXTURES_WRITE=1 npx vitest run src/lib/haParity.test.ts to write ${FILE}'s answers`).toBeDefined();
    expect(Object.keys(fixtures.expect!.scenarios).sort()).toEqual(fixtures.scenarios.map((s) => s.name).sort());
  });

  it('matches the words as before', () => {
    expect(got.words).toEqual(fixtures.expect?.words);
  });

  for (const sc of fixtures.scenarios) {
    it(sc.name, () => {
      expect(got.scenarios[sc.name]).toEqual(fixtures.expect?.scenarios[sc.name]);
    });
  }

  it('the fixtures cover the merge, the safety catch and the line ids', () => {
    const all = JSON.stringify(got.scenarios);
    for (const call of ['"add ', '"update ', '"remove ']) expect(all).toContain(call);
    expect(all).toContain('"held":true');
    expect(all).toContain(haLineId('todo.shopping_list', 'u1'));
    expect(all).toContain(haLineId('todo.groceries', 'u1'));
    expect(all).toContain('"error"');
  });
});
