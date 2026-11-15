import { describe, expect, it } from 'vitest';
import { historyLabel, keepDays, KEEP_WEEKS, keepWeeks } from '../types';
import { seenKeepWeeks } from './seen';
import { checkSettings } from './settingsCheck';

describe('0.11.1: 9 months of price history', () => {
  it('is a choice between 6 and 12 months', () => {
    expect([...KEEP_WEEKS]).toEqual([8, 26, 39, 52]);
    expect(historyLabel(39)).toBe('9 months');
    expect(keepWeeks(39)).toBe(39);
    expect(keepWeeks(30)).toBe(39); // an in-between number becomes the next one up
  });
  it('gets the 12-month shared history (there is no 9-month file)', () => {
    expect(keepDays(39)).toBe(365);
    expect(keepDays(26)).toBe(182);
    expect(checkSettings({ checkMoved0110: true, historyWeeks: 39 }).marketData.days).toBe(365);
  });
  it('survives a settings check, and search results can be kept for 9 months too', () => {
    expect(checkSettings({ historyWeeks: 39 }).historyWeeks).toBe(39);
    expect(checkSettings({ historyWeeks: 8, searchKeepWeeks: 39 }).searchKeepWeeks).toBe(39);
    expect(seenKeepWeeks({ historyWeeks: 8, searchKeepWeeks: 39 })).toBe(39);
  });
});
