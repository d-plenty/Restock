// 0.15.1: the sync engine's work is steps (generators) that run on either kind of database. A step
// that calls another step must hand its questions on (yield*): called plainly it would do nothing
// and answer a generator. This reads the engine to make sure none is called plainly.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import initSqlJs from 'sql.js';
import { AsyncSyncEngine, WebSyncEngine, type AsyncSyncDb } from './engine';
import { syncDbOf } from './sqldb';

const src = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');
const sf = ts.createSourceFile('engine.ts', src, ts.ScriptTarget.Latest, true);

describe('the engine as steps', () => {
  test('every step that calls another step hands its questions on', () => {
    const core = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'SyncCore')!;
    const steps = new Set(core.members.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !!m.asteriskToken).map((m) => (m.name as ts.Identifier).text));
    expect(steps.size).toBeGreaterThan(40);
    const plain: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        const name = ts.isPropertyAccessExpression(c) && c.expression.kind === ts.SyntaxKind.ThisKeyword ? c.name.text : ts.isIdentifier(c) ? c.text : '';
        if (steps.has(name) || ['qry', 'run', 'txn'].includes(name)) {
          let p = n.parent;
          while (ts.isParenthesizedExpression(p)) p = p.parent;
          if (!(ts.isYieldExpression(p) && p.asteriskToken)) plain.push(`${name} at line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(core);
    expect(plain).toEqual([]);
  });

  test('the same engine runs on a database that answers at once and on one that answers later', async () => {
    const SQL = await initSqlJs();
    const make = () => {
      const db = new SQL.Database();
      db.run('CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)');
      db.run('CREATE TABLE household (k TEXT PRIMARY KEY, v TEXT)');
      return db;
    };
    const ok = () => true;
    const text = () => '';
    const now = new WebSyncEngine(syncDbOf(make()), ok, text);
    now.setMeta('device', 'p1');
    expect(now.device()).toBe('p1');
    const sync = syncDbOf(make());
    let held = false;
    const later: AsyncSyncDb = {
      query: async (s, a) => (expect(held || !s.startsWith('INSERT')).toBe(true), sync.query(s, a)),
      exec: async (s, a) => sync.exec(s, a),
      transaction: async (body) => {
        held = true;
        try {
          await body();
        } finally {
          held = false;
        }
      },
    };
    const eng = new AsyncSyncEngine(later, ok, text);
    await eng.setMeta('device', 'p2');
    expect(await eng.device()).toBe('p2');
    expect(eng.role).toBe('web');
    // Its own way to the database: each call holds it, as the engine's own do.
    expect((await eng.db.query('SELECT value FROM sync_meta WHERE key = ?', ['device']))[0].value).toBe('p2');
  });
});
