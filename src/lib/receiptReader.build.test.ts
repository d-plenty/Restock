import { describe, expect, it } from 'vitest';
import { assetFileName } from './assetNames';

// Android unpacks files ending in ".gz" when it builds the app and drops the ending, so the
// receipt reader's model went missing ("Couldn't load the receipt reader (404)") until 0.8.7.
describe('receipt reader files', () => {
  it('builds the model without a plain ".gz" ending', () => {
    expect(assetFileName({ names: ['eng.traineddata.gz'] })).toBe('assets/[name]-[hash].gz.bin');
  });

  it('leaves every other file as it is', () => {
    expect(assetFileName({ names: ['worker.min.js'] })).toBe('assets/[name]-[hash][extname]');
  });
});
