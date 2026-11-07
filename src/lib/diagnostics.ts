import { chainName, type StoreChain } from '../shops';
import { getKV, putKV } from './db';

// "What went wrong": the latest problems from each shop, in plain words, for Settings →
// Diagnostics. Kept on the phone only. And a recorder that captures exactly what shops send back
// during one search, for "Send search details" (so a shop's connection can be fixed).

export interface Problem {
  at: string;
  chain: StoreChain;
  what: 'search' | 'price check' | 'recalls' | 'backup' | 'other';
  message: string;
}

const KEY = 'diagnostics';
const MAX = 80;

export async function logProblem(chain: StoreChain, what: Problem['what'], message: string): Promise<void> {
  try {
    const list = ((await getKV<Problem[]>(KEY)) ?? []).filter((p) => p && typeof p.message === 'string');
    list.unshift({ at: new Date().toISOString(), chain, what, message: message.slice(0, 500) });
    await putKV(KEY, list.slice(0, MAX));
  } catch {
    // diagnostics are best-effort
  }
}

export async function problems(): Promise<Problem[]> {
  return ((await getKV<Problem[]>(KEY)) ?? []).filter((p) => p && typeof p.message === 'string');
}

export async function clearProblems(): Promise<void> {
  await putKV(KEY, []);
}

/** The problems as plain text, for copying into a message or a GitHub issue. */
export function problemsText(list: Problem[], appVersion: string): string {
  const lines = [`Restock ${appVersion} diagnostics, ${new Date().toLocaleString('en-AU')}`, ''];
  for (const p of list) lines.push(`${new Date(p.at).toLocaleString('en-AU')} · ${chainName(p.chain)} · ${p.what}: ${p.message}`);
  if (!list.length) lines.push('No problems recorded.');
  return lines.join('\n');
}

// ---------- capturing what a shop sends back ----------

export interface Captured {
  kind: 'request' | 'browser fetch' | 'browser page';
  url: string;
  status: number;
  body: string;
}

let capturing: Captured[] | undefined;
const LIMIT = 400_000;

/** Called by the shop connections for every answer while a capture is running. */
export function capture(kind: Captured['kind'], url: string, status: number, body: string) {
  if (!capturing) return;
  capturing.push({ kind, url, status, body: body.length > LIMIT ? `${body.slice(0, LIMIT)}\n…(cut at ${LIMIT} characters)` : body });
}

/** Run `fn` and return everything the shops sent back while it ran. */
export async function captureWhile<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: string; captured: Captured[] }> {
  capturing = [];
  try {
    const result = await fn();
    return { result, captured: capturing };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), captured: capturing };
  } finally {
    capturing = undefined;
  }
}
