import { describe, expect, it } from 'vitest';
import { storeNameFrom } from './web';

describe('0.10.7 the store picked on IGA’s website', () => {
  it('reads it back from the page', () => {
    expect(storeNameFrom('<div><span>Click &amp; Collect from</span><h3>Westbury&#39;s Mundingburra IGA</h3><button>View Map</button></div>')).toBe(
      "Westbury's Mundingburra IGA",
    );
    expect(storeNameFrom('<p>Shopping at Cornetts IGA Garbutt</p>')).toBe('Cornetts IGA Garbutt');
  });
  it("says nothing when it can't tell", () => {
    expect(storeNameFrom('<p>Click &amp; Collect from</p><button>Select Store</button>')).toBeUndefined();
    expect(storeNameFrom('<p>Specials</p>')).toBeUndefined();
  });
});
