// 0.9.6 (M1, L3): the Java side (PriceCheckWorker, PriceChecker) can't run in vitest. These check that the
// source keeps the pieces the fix relies on, and that CheckSchedule says a check is owed after a miss.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const J = 'android/app/src/main/java/family/plenty/restock/';
const worker = readFileSync(`${J}PriceCheckWorker.java`, 'utf8');
const checker = readFileSync(`${J}PriceChecker.java`, 'utf8');

describe('missed check catch-up (source)', () => {
  it('schedule() queues a catch-up soon when a check is owed, once (unique name, KEEP)', () => {
    expect(worker).toMatch(/UNIQUE_NAME_CATCHUP = "restock-price-check-catchup"/);
    expect(worker).toMatch(/if \(due\) enqueue\(ctx, cs, zone, now, UNIQUE_NAME_CATCHUP, ExistingWorkPolicy\.KEEP, CATCHUP_DELAY_MS\)/);
    expect(worker).toMatch(/cancelUniqueWork\(UNIQUE_NAME_CATCHUP\)/);
  });
  it('a catch-up job does not queue another scheduled job, and a running one is not replaced', () => {
    expect(worker).toMatch(/UNIQUE_NAME_CATCHUP\.equals\(me\)/);
    expect(worker).toMatch(/running\(wm, UNIQUE_NAME\)/);
    expect(worker).toMatch(/ExistingWorkPolicy\.KEEP, 0\)/);
  });
  it('two checks never overlap', () => {
    expect(checker).toMatch(/ACTIVE\.getAndIncrement\(\) > 0/);
    expect(checker).toMatch(/if \(busy && fromBackground\) return new Result\(\)/);
    expect(checker).toMatch(/private static synchronized Result runLocked/);
  });
});
