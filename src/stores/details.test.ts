import { describe, expect, it } from 'vitest';
import { extractDetails, fromOpenFoodFacts, nutritionTable } from './details';

describe('product details', () => {
  it('reads a Woolworths-style detail response', () => {
    const d = extractDetails(
      {
        Product: { Name: 'Nutella 750g', Description: '<p>Hazelnut spread with <b>cocoa</b>, perfect on toast and in baking.</p>' },
        AdditionalAttributes: {
          ingredients: 'Sugar, Palm Oil, Hazelnuts (13%), Skim Milk Powder (8.7%), Fat-Reduced Cocoa (7.4%)',
          allergystatement: 'Contains Milk, Hazelnut and Soy.',
          nutritionalinformation: JSON.stringify([
            { Name: 'Energy', Values: { 'Quantity Per Serve': '317kJ', 'Quantity Per 100g / 100mL': '2260kJ' } },
            { Name: 'Protein', Values: { 'Quantity Per Serve': '0.8g', 'Quantity Per 100g / 100mL': '6.0g' } },
          ]),
          storageinstructions: 'Store in a cool, dry place.',
          countryoforigin: 'Made in Australia from imported and local ingredients',
        },
      },
      'woolworths.com.au',
    );
    expect(d.ingredients).toMatch(/^Sugar, Palm Oil/);
    expect(d.allergens).toBe('Contains Milk, Hazelnut and Soy.');
    expect(d.description).toBe('Hazelnut spread with cocoa, perfect on toast and in baking.');
    expect(d.nutrition?.header).toEqual(['Per Serve', 'Per 100g / 100mL']);
    expect(d.nutrition?.rows[0]).toEqual({ name: 'Energy', values: ['317kJ', '2260kJ'] });
    expect(d.important.map((i) => i.label)).toEqual(['Storage', 'Country of origin']);
  });

  it('reads a sectioned nutrition panel', () => {
    const t = nutritionTable({
      servingSize: '15g',
      breakdown: [
        { title: 'Per serve', nutrients: [{ nutrient: 'Energy', value: '317kJ' }] },
        { title: 'Per 100g', nutrients: [{ nutrient: 'Energy', value: '2260kJ' }] },
      ],
    });
    expect(t).toEqual({ header: ['Per serve', 'Per 100g'], rows: [{ name: 'Energy', values: ['317kJ', '2260kJ'] }], note: 'Serving size: 15g' });
  });

  it('reads Open Food Facts', () => {
    const d = fromOpenFoodFacts({
      status: 1,
      product: { ingredients_text: 'Yeast extract, salt', allergens_tags: ['en:gluten'], nutriments: { 'energy-kj_100g': 776, sodium_100g: 3.45 } },
    });
    expect(d?.allergens).toBe('Contains: gluten');
    expect(d?.nutrition?.rows).toEqual([
      { name: 'Energy', values: ['776 kJ'] },
      { name: 'Sodium', values: ['3450 mg'] },
    ]);
  });
});

describe('barcodes on shop pages', () => {
  it('reads the barcode wherever the page keeps it', () => {
    expect(extractDetails({ Product: { Barcode: '9310692112198', Description: 'A dishwashing liquid that is tough on grease.' } }, 'x').barcode).toBe(
      '9310692112198',
    );
    expect(extractDetails({ gtin: 9300633001234 }, 'x').barcode).toBe('9300633001234');
    expect(extractDetails({ barcode: 'n/a' }, 'x').barcode).toBeUndefined();
  });
});
