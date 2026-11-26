// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { OpeningPreview } from './OpeningPreview';

// 0.16.0: Settings → Look and colours → See the openings.
afterEach(cleanup);

describe('see the openings', () => {
  test('every holiday, day and night, plays on the spot', () => {
    render(<OpeningPreview still={false} onClose={() => undefined} />);
    for (const n of ['The usual one', 'Christmas', 'New Year', 'Australia Day', 'Easter', 'Halloween']) expect(screen.getByText(n)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play New Year, night' }));
    expect(document.querySelector('.opening.op-newyear.op-night')).toBeTruthy();
    expect(screen.getByText('Happy New Year')).toBeTruthy();
  });
  test('with less motion, the still picture', () => {
    render(<OpeningPreview still onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play Easter, day' }));
    expect(document.querySelector('.opening.op-still')).toBeTruthy();
  });
});
