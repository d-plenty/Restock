import { describe, expect, it } from 'vitest';
import { goTo, mapEndeavour } from './endeavour';

// From the phone search test (0.8.6): Dan Murphy's put a sales blurb where the name goes, and
// answered "beer" with where to go instead of products.
describe("Dan Murphy's", () => {
  const details = (o: Record<string, string>) => Object.entries(o).map(([Name, Value]) => ({ Name, Value }));

  it('uses the name, not the blurb', () => {
    const p = mapEndeavour('danmurphys', {
      Stockcode: '6076024',
      Prices: { singleprice: { Value: 5.49 } },
      AdditionalDetails: details({
        webbrandname: 'Great Northern Brewing Co.',
        webdescriptionshort: 'Great Northern Super Crisp lager was brewed with an outdoor lifestyle in mind',
        producttitle: 'Super Crisp Lager Cans 375mL',
        productname: 'Great Northern Brewing Co. Super Crisp Lager Cans 375mL',
      }),
    });
    expect(p?.name).toBe('Great Northern Brewing Co. Super Crisp Lager Cans 375mL');
  });

  it('keeps an ordinary name', () => {
    const p = mapEndeavour('bws', { Stockcode: '1', Name: 'Sheep Dog Peanut Butter Whiskey Liqueur 700ml', Prices: { singleprice: { Value: 50 } } });
    expect(p?.name).toBe('Sheep Dog Peanut Butter Whiskey Liqueur 700ml');
  });

  it('follows "go here instead"', () => {
    const text = JSON.stringify([
      { ActionType: 'GoToUrl', RedirectTarget: 'Self', RedirectUrl: 'https://www.danmurphys.com.au/beer/all', MobileDestination: 'Product listing' },
    ]);
    expect(goTo({ status: 200, text, headers: {} })).toBe('https://www.danmurphys.com.au/beer/all');
    expect(goTo({ status: 200, text: JSON.stringify({ Products: [] }), headers: {} })).toBeUndefined();
  });
});
