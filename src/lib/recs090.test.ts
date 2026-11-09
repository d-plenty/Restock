// 0.9.0: which shops' prices count: the ones switched on, on a tab that's on, with the website their
// prices come from (the same shops the price check checks).
import { describe, expect, it } from 'vitest';
import { shopsOn } from './recs';

describe('shops that count', () => {
  it('are the grocery shops picked', () => {
    const on = shopsOn({ enabledChains: ['woolworths', 'coles'], sections: { keg: false, pharmacy: false } });
    expect([...on].sort()).toEqual(['coles', 'woolworths']);
  });

  it("leave out a tab's shops while the tab is off", () => {
    const on = shopsOn({ enabledChains: ['coles', 'bws', 'liquorlandwarehouse'], sections: { keg: false, pharmacy: false } });
    expect([...on]).toEqual(['coles']);
  });

  it('include the website a shop is priced from', () => {
    const on = shopsOn({ enabledChains: ['coles', 'liquorlandwarehouse', 'mychemist'], sections: { keg: true, pharmacy: true } });
    expect([...on].sort()).toEqual(['chemistwarehouse', 'coles', 'liquorland', 'liquorlandwarehouse', 'mychemist']);
  });
});
