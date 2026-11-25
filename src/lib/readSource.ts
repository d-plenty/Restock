// Tests only: a source file's text, for the tests that check what a screen says or does in its code.
// 0.15.0: the big screens were split; a screen's text is its own file and the parts moved out of it,
// so those tests read the screen as a whole, wherever each part now lives.
import { readFileSync } from 'node:fs';

/** Each split screen, and the files its parts moved to (in src/ui/screens). */
const SCREEN_PARTS: Record<string, string[]> = {
  'Add.tsx': ['AddSheets.tsx'],
  'Item.tsx': ['ItemSheets.tsx', 'ItemHistory.tsx'],
  'List.tsx': ['ShoppingMode.tsx'],
  'Settings.tsx': ['SettingsParts.tsx'],
  'Sync.tsx': ['SyncCodes.tsx', 'SyncServer.tsx', 'SyncSheets.tsx'],
};

/** The file's text; for a split screen, followed by its parts' text. */
export function readSource(url: URL): string {
  const own = readFileSync(url, 'utf8');
  const name = url.pathname.split('/').pop() ?? '';
  const parts = url.pathname.includes('/ui/screens/') ? (SCREEN_PARTS[name] ?? []) : [];
  return [own, ...parts.map((p) => readFileSync(new URL(p, url), 'utf8'))].join('\n');
}
