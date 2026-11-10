import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { logsKeepText, monthsWord, serverKeepText } from './autoDelete';

// 0.9.5 (final review): Auto delete's words on the phone and the web, for any number of months.

describe('Auto delete words', () => {
  it('the phone says what the server keeps, for a custom number too', () => {
    expect(serverKeepText(7)).toBe('Auto delete on the server is on: prices and receipts older than 7 months are deleted there every night.');
    expect(serverKeepText(1)).toContain('older than 1 month are');
    expect(serverKeepText(null)).toBe('Auto delete on the server is off: it keeps everything until someone deletes it.');
    expect(serverKeepText(undefined)).toContain('is off');
    // "keeps everything until someone deletes it" only when it's off.
    for (const m of [1, 3, 7, 12, 120]) expect(serverKeepText(m)).not.toContain('until someone deletes it');
  });

  it('activity and logs on the web', () => {
    expect(logsKeepText(12)).toBe('Auto delete removes them after 12 months.');
    expect(logsKeepText(1)).toBe('Auto delete removes them after 1 month.');
    expect(logsKeepText(null)).toBe('Auto delete is off, so they stay until someone deletes them.');
    expect(logsKeepText(undefined)).toBe('Auto delete (in Data) says how long they stay.');
    expect(monthsWord(2)).toBe('2 months');
  });

  it('no "Keep data for" left where people read it', () => {
    for (const f of ['src/ui/screens/RestockServer.tsx', 'src/server-mode/ui/DeskActivity.tsx', 'src/server-mode/ui/DeskDataManage.tsx', 'src/server-mode/ui/DeskData.tsx']) {
      // Comments may say what it used to be called; strings may not.
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Keep data for/);
      // 0.9.5 review: "Kept for until i delete" (keepLabel(null).toLowerCase()).
      if (!f.includes('DeskData')) expect(code, f).not.toMatch(/keepLabel|until i delete/i);
    }
  });
});
