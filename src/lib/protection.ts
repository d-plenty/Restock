/**
 * 0.9.3: is this phone's data kept somewhere else? Any of three counts, and any mix is fine:
 *
 * - a local backup (automatic backups into a folder),
 * - phone-to-phone sync (in a household: the other phones hold the shared parts),
 * - a Restock server the household runs itself.
 *
 * With only sync or only a server, Restock still suggests a local backup too: sync copies mistakes
 * to every phone, and a server can be down or out of reach when you need it. Even weekly backups
 * kept for 4 weeks cover that.
 */
export interface Protection {
  local: boolean;
  phones: boolean;
  server: boolean;
  /** At least one of the three. */
  covered: boolean;
  /** Covered, but only by sync or a server: worth adding a local backup. */
  suggestLocal: boolean;
  /** Short, for a setup tile: "Backed up", "Synced", "Server", "Backup + server"… */
  short: string;
}

/** The suggested local backup: weekly, keeping the newest 4 (about 4 weeks). */
export const LOCAL_SUGGESTED = { everyDays: 7, keep: 4 } as const;

export function protection(autoBackupOn: boolean, sync?: { paired?: boolean; server?: boolean; members?: unknown[] } | null): Protection {
  const local = !!autoBackupOn;
  // A household of one phone has no other phone holding a copy yet.
  const phones = !!sync?.paired && (sync.members ? sync.members.length > 1 : true);
  const server = !!sync?.server;
  const covered = local || phones || server;
  const parts = [local ? 'Backup' : '', server ? 'server' : '', phones && !server ? 'phones' : ''].filter(Boolean);
  let short = 'Off';
  if (parts.length === 1) short = local ? 'Backed up' : server ? 'Server' : 'Synced';
  else if (parts.length > 1) short = parts.map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p)).join(' + ');
  return { local, phones, server, covered, suggestLocal: covered && !local, short };
}

/** Why a local backup is worth it as well, in words for what this phone uses. */
export function suggestLocalText(p: Protection): string {
  if (p.server)
    return "Your Restock server keeps a copy, but if it's down or out of reach you can't get to it. Keep a backup on this phone too: even weekly backups kept for 4 weeks cover that.";
  return 'Phone-to-phone sync works offline with no server, but a mistake on one phone goes to every phone. Keep a backup on this phone too: even weekly backups kept for 4 weeks let you go back.';
}

/** What the Sync and backups strip shows: all well, or the first thing that needs you. */
export interface SyncStatus {
  ok: boolean;
  title: string;
  /** One cell per way this phone keeps a copy: "Phones · 3 min ago". */
  cells: { label: string; when: string | null | undefined }[];
}

export function syncStatus(
  auto: { enabled: boolean; lastAt?: string; lastError?: string },
  info:
    | {
        paired?: boolean;
        server?: boolean;
        serverAt?: string | null;
        serverError?: string | null;
        folder?: string | null;
        folderAt?: string | null;
        folderError?: string | null;
        lastSyncAt?: string | null;
        members?: unknown[];
      }
    | null
    | undefined,
  now = Date.now(),
): SyncStatus {
  const p = protection(auto.enabled, info);
  const cells: SyncStatus['cells'] = [];
  if (p.phones) cells.push({ label: 'Phones', when: info?.lastSyncAt });
  if (info?.folder) cells.push({ label: 'Away', when: info.folderAt });
  if (p.server) cells.push({ label: 'Server', when: info?.serverAt });
  if (p.local) cells.push({ label: 'Backup', when: auto.lastAt });
  const WEEK = 7 * 86_400_000;
  const problem =
    (!p.covered && "Nothing's kept anywhere else yet") ||
    (p.local && auto.lastError && 'The last automatic backup failed') ||
    (p.server && info?.serverError && "Your Restock server can't be reached") ||
    (info?.folder && info.folderError && "Sync away from home isn't working") ||
    (p.phones &&
      !p.server &&
      !info?.folder &&
      (!info?.lastSyncAt || now - Date.parse(info.lastSyncAt) > WEEK) &&
      "Your phones haven't synced in a week") ||
    '';
  return { ok: !problem, title: problem || 'All up to date', cells };
}
