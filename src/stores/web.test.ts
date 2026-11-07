import { DOMParser as LinkeDOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { flattenEndeavour } from './endeavour';
import {
  cardPrice,
  cleanName,
  embeddedJson,
  extractProducts,
  findSearch,
  fromCards,
  fromEmbedded,
  fromJsonLd,
  fromShopifySuggest,
  fromWooStore,
  platformOf,
  searchUrl,
} from './webPage';

const parse = (html: string) => new LinkeDOMParser().parseFromString(html, 'text/html') as unknown as Document;
const BASE = 'https://www.example-pharmacy.com.au/search?q=panadol';

describe('reading products off shop pages', () => {
  it('reads a JSON-LD list of products with offers, sale prices and stock', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: [
        {
          '@type': 'ListItem',
          item: {
            '@type': 'Product',
            name: 'Panadol Tablets 500mg 20 Pack',
            url: '/buy/123/panadol-20',
            image: ['https://img.example.com/123.jpg'],
            gtin13: '9300673800013',
            brand: { '@type': 'Brand', name: 'Panadol' },
            offers: {
              '@type': 'Offer',
              price: '4.99',
              priceCurrency: 'AUD',
              availability: 'https://schema.org/InStock',
              priceSpecification: [{ '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: 7.49 }],
            },
          },
        },
        {
          '@type': 'ListItem',
          item: { '@type': 'Product', name: 'Panadol Rapid 20', url: '/buy/456', offers: { price: 6.5, availability: 'OutOfStock' } },
        },
      ],
    })}</script></head><body></body></html>`;
    const out = fromJsonLd('chemistwarehouse', html, BASE);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      chain: 'chemistwarehouse',
      storeProductId: 'https://www.example-pharmacy.com.au/buy/123/panadol-20',
      name: 'Panadol Tablets 500mg 20 Pack',
      brand: 'Panadol',
      barcode: '9300673800013',
      price: 4.99,
      wasPrice: 7.49,
      isSpecial: true,
      inStock: true,
      size: '20 Pack',
    });
    expect(out[1]).toMatchObject({ price: 6.5, inStock: false, isSpecial: false });
  });

  it('reads products from the data a Next.js page starts with', () => {
    const data = {
      props: {
        pageProps: {
          results: {
            products: [
              {
                id: 'A1',
                name: 'Great Northern Super Crisp 30 Pack 375ml',
                slug: '/p/gn-crisp-30',
                price: { now: 54, was: 62 },
                image: { url: '/i/a1.png' },
              },
              { id: 'A2', name: 'XXXX Gold 30 Pack 375ml', urlKey: 'xxxx-gold-30', price: 52.5 },
            ],
          },
        },
      },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
    const out = fromEmbedded('bottleo', embeddedJson(html), 'https://www.thebottle-o.com.au/search?q=beer');
    expect(out.map((p) => p.storeProductId)).toEqual([
      'https://www.thebottle-o.com.au/p/gn-crisp-30',
      'https://www.thebottle-o.com.au/products/xxxx-gold-30',
    ]);
    expect(out[0]).toMatchObject({ price: 54, wasPrice: 62, isSpecial: true, imageUrl: 'https://www.thebottle-o.com.au/i/a1.png' });
    expect(out[1].price).toBe(52.5);
  });

  it('reads window.__INITIAL_STATE__ = {...} without being fooled by braces in strings', () => {
    const html = `<script>window.__INITIAL_STATE__ = {"search":{"items":[{"sku":"77","title":"Vitamin C {500mg} 120 Tabs","price":"$19.99","url":"/vit-c"}]}};</script>`;
    const out = fromEmbedded('priceline', embeddedJson(html), 'https://www.priceline.com.au/search?q=vitamin');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Vitamin C {500mg} 120 Tabs', price: 19.99, storeProductId: 'https://www.priceline.com.au/vit-c' });
  });

  it('reads plain product cards, with crossed-out was prices', () => {
    const card = (n: number, name: string, now: string, was?: string) => `
      <li class="product-tile card">
        <a href="/product/${n}"><img src="/img/${n}.jpg" alt="${name}"></a>
        <h3 class="product-name"><a href="/product/${n}">${name}</a></h3>
        <div class="price"><span class="now">${now}</span>${was ? `<s>${was}</s>` : ''}</div>
      </li>`;
    const html = `<html><body><header><a href="/cart">Cart $0.00</a></header><ul class="grid">
      ${card(1, 'Nurofen 200mg 24 Tablets', '$8.99', '$12.49')}
      ${card(2, 'Band-Aid Plastic Strips 40 Pack', '$4.50')}
      ${card(3, 'Panadol Optizorb 20', '$5.25')}
    </ul><footer>Free delivery over $50.00</footer></body></html>`;
    const out = fromCards('blooms', html, 'https://www.bloomsthechemist.com.au/search?q=pain', parse);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      name: 'Nurofen 200mg 24 Tablets',
      storeProductId: 'https://www.bloomsthechemist.com.au/product/1',
      price: 8.99,
      wasPrice: 12.49,
      imageUrl: 'https://www.bloomsthechemist.com.au/img/1.jpg',
    });
    expect(out[1]).toMatchObject({ price: 4.5, wasPrice: undefined, isSpecial: false });
  });

  it('prefers JSON-LD, then page data, then cards', () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"One","url":"/one","offers":{"price":1}}</script>
      <script type="application/ld+json">{"@type":"Product","name":"Two","url":"/two","offers":{"price":2}}</script>`;
    expect(extractProducts('chempro', html, 'https://www.chempro.com.au/', parse).map((p) => p.name)).toEqual(['One', 'Two']);
    expect(extractProducts('chempro', '<html><body>Nothing here</body></html>', 'https://www.chempro.com.au/', parse)).toEqual([]);
  });

  it('reads Shopify and WooCommerce search data', () => {
    const shopify = fromShopifySuggest(
      'stardiscount',
      {
        resources: {
          results: {
            products: [
              {
                title: 'Panadol 20',
                url: '/products/panadol-20?_pos=1',
                price: '3.99',
                compare_at_price_max: '5.99',
                available: true,
                image: 'https://cdn.shopify.com/x.jpg',
              },
            ],
          },
        },
      },
      'https://www.stardiscountchemist.com.au',
    );
    expect(shopify[0]).toMatchObject({
      storeProductId: 'https://www.stardiscountchemist.com.au/products/panadol-20',
      price: 3.99,
      wasPrice: 5.99,
      inStock: true,
    });
    const woo = fromWooStore(
      'goodprice',
      [
        {
          id: 9,
          name: 'Ural Sachets 28',
          permalink: 'https://shop.example.com/ural',
          prices: { price: '1099', regular_price: '1399', sale_price: '1099', currency_minor_unit: 2 },
          is_in_stock: true,
        },
      ],
      'https://shop.example.com',
    );
    expect(woo[0]).toMatchObject({ price: 10.99, wasPrice: 13.99, storeProductId: 'https://shop.example.com/ural' });
  });
});

describe('finding a shop’s search page', () => {
  it('uses the schema.org SearchAction when there is one', () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","url":"https://www.liquorland.com.au/","potentialAction":{"@type":"SearchAction","target":"https://www.liquorland.com.au/search?q={search_term_string}","query-input":"required name=search_term_string"}}</script>`;
    const info = findSearch(html, 'https://www.liquorland.com.au', parse);
    expect(info.search).toBe('https://www.liquorland.com.au/search?q={q}');
    expect(searchUrl(info.search!, 'great northern')).toBe('https://www.liquorland.com.au/search?q=great%20northern');
  });

  it('falls back to the search box, keeping its hidden fields', () => {
    const html = `<form action="/catalogsearch/result/" method="get"><input type="hidden" name="cat" value="all"><input type="search" name="q"></form>`;
    expect(findSearch(html, 'https://www.pharmacy4less.com.au', parse).search).toBe(
      'https://www.pharmacy4less.com.au/catalogsearch/result/?cat=all&q={q}',
    );
  });

  it('knows Shopify, WooCommerce and Magento sites, and guesses when it has to', () => {
    expect(platformOf('<link href="https://cdn.shopify.com/s/files/x.css">')).toBe('shopify');
    expect(platformOf('<body class="woocommerce-page">')).toBe('woocommerce');
    expect(findSearch('<script src="https://cdn.shopify.com/a.js"></script>', 'https://shop.example.com', parse)).toMatchObject({
      platform: 'shopify',
      search: 'https://shop.example.com/search?q={q}&type=product',
    });
    expect(findSearch('<html></html>', 'https://www.example.com.au', parse).search).toBe('https://www.example.com.au/search?q={q}');
  });
});

describe("Dan Murphy's and BWS", () => {
  it('reads single, promo and member prices from bundles', () => {
    const out = flattenEndeavour('danmurphys', {
      Products: [
        {
          Products: [
            {
              Stockcode: '915769',
              Name: 'Super Crisp Lager Can 375mL',
              Prices: { singleprice: { Value: 62.99, Message: 'Case of 30' }, promoprice: { Value: 54.0, Message: 'Save $8.99 on a case' } },
              AdditionalDetails: [
                { Name: 'webbrandname', Value: 'Great Northern' },
                { Name: 'image1', Value: 'https://media.danmurphys.com.au/dmo/product/915769-1.png' },
                { Name: 'webliquorsize', Value: '375mL' },
              ],
            },
          ],
        },
        { Products: [{ Stockcode: 'X2', Name: 'Hahn Super Dry 330mL', Prices: { singleprice: { Value: 21 }, memberprice: { Value: 19 } } }] },
        { Products: [{ Stockcode: 'X3', Name: 'No price' }] },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      chain: 'danmurphys',
      storeProductId: '915769',
      name: 'Great Northern Super Crisp Lager Can 375mL',
      price: 54,
      wasPrice: 62.99,
      isSpecial: true,
      size: '375mL',
      promo: 'Save $8.99 on a case',
    });
    expect(out[1]).toMatchObject({ price: 19, memberOnly: true });
  });
});

describe('tidying what shop pages show', () => {
  it('cleans names the way they read in your screenshots', () => {
    expect(cleanName('View details for Jack Daniels Tennessee Whiskey 1 Litre')).toBe('Jack Daniels Tennessee Whiskey 1 Litre');
    expect(cleanName('Nurofen for Children Orange 100ml^ (always read the label)')).toBe('Nurofen for Children Orange 100ml');
    expect(
      cleanName(
        "Jack Daniel's Old No.7Tennessee Whiskey 700ML One of the few Tennessee Whiskies that is charcoal mellowed, which gives Jack Daniel's its distinctive smooth and smoky flavours.",
      ),
    ).toBe("Jack Daniel's Old No.7 Tennessee Whiskey 700ML");
    expect(cleanName('ApoHealth Ibuprofen 96 Tablets')).toBe('ApoHealth Ibuprofen 96 Tablets');
  });

  it('takes the shelf price, not a saving, a unit price or an instalment', () => {
    const card = (html: string) => parse(`<html><body><div class="card">${html}</div></body></html>`).querySelector('.card')!;
    expect(cardPrice(card('<span class="price">$83.00</span> <s>$91.00</s> <span class="badge">Save $8.00</span>'))).toEqual({ price: 83, was: 91 });
    expect(cardPrice(card('<span>Save $8.00</span> <span>$83.00</span> <span>Was $91.00</span>'))).toEqual({ price: 83, was: 91 });
    expect(cardPrice(card('<b>$15.46</b> <small>$12.37 per 100g</small> <small>or 4 payments of $3.87</small>'))).toEqual({
      price: 15.46,
      was: undefined,
    });
    expect(cardPrice(card('<b>$4.99</b> <span>$2.50 / 100ml</span>'))).toEqual({ price: 4.99, was: undefined });
  });

  it("doesn't believe a 90% discount", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Sudocrem 125g","url":"/sudocrem","offers":{"price":1.07,"priceSpecification":{"priceType":"https://schema.org/ListPrice","price":15.46}}}</script>`;
    const [p] = fromJsonLd('chempro', html, 'https://www.chempro.com.au/');
    expect(p).toMatchObject({ price: 15.46, wasPrice: undefined, isSpecial: false });
  });

  it('prefers a whole name from the image over a cut-short heading', () => {
    const html = `<html><body><ul>${[1, 2]
      .map(
        (n) =>
          `<li class="tile"><a href="/p/${n}"><img src="/i/${n}.jpg" alt="TerryWhite Chemmart Paracetamol Pain Relief Children 5-12 Years - 200ml"></a><h3>TerryWhite Chemmart ...ears - 200ml^</h3><span class="price">$13.49</span></li>`,
      )
      .join('')}</ul></body></html>`;
    const out = fromCards('terrywhite', html, 'https://terrywhitechemmart.com.au/search?q=x', parse);
    expect(out[0].name).toBe('TerryWhite Chemmart Paracetamol Pain Relief Children 5-12 Years - 200ml');
  });
});

describe("Dan Murphy's and BWS pictures and names", () => {
  it('always gives a full picture link and a short name', async () => {
    const { mapEndeavour, pictureOf } = await import('./endeavour');
    expect(pictureOf('bws', '12345', '/media/x.png')).toBe('https://bws.com.au/media/x.png');
    expect(pictureOf('bws', '12345', 'x.png')).toBe('https://edgmedia.bws.com.au/bws/media/products/12345-1.png');
    expect(pictureOf('danmurphys', '9', '//media.danmurphys.com.au/a.png')).toBe('https://media.danmurphys.com.au/a.png');
    const p = mapEndeavour('danmurphys', {
      Stockcode: 18742,
      Name: "Jack Daniel's Old No.7 Tennessee Whiskey 700mL Mellowed drop by drop through 10 feet of sugar maple charcoal, then matured in handcrafted barrels of our own making. And our whiskey doesn't follow a calendar.",
      Prices: { singleprice: { Value: 64.99 } },
    })!;
    expect(p.name).toBe("Jack Daniel's Old No.7 Tennessee Whiskey 700mL");
    expect(p.imageUrl).toBe('https://media.danmurphys.com.au/dmo/product/18742-1.png');
  });
});

describe('telling a bot check from a page with no matches', () => {
  it('only calls it blocked when the shop showed a holding page', async () => {
    const { looksLikeBotCheck } = await import('./web');
    expect(looksLikeBotCheck('<html><title>Just a moment...</title><body>Checking your browser</body></html>')).toBe(true);
    expect(looksLikeBotCheck('<html><script src="/cdn-cgi/challenge-platform/h/b"></script></html>')).toBe(true);
    expect(looksLikeBotCheck('<html><title>Search results for xyz</title><body>Sorry, no products matched</body></html>')).toBe(false);
  });
});

describe('names the way your screenshots showed them', () => {
  it('rebuilds names the shop cut short, using the product link', async () => {
    const { repairName } = await import('./webPage');
    expect(
      repairName(
        'Hard Rated OrangePassionfruit Zero... 375ML',
        'https://www.danmurphys.com.au/product/DM_929475/hard-rated-orange-passionfruit-zero-sugar-cans-375ml',
      ),
    ).toBe('Hard Rated Orange Passionfruit Zero Sugar Cans 375ML');
    expect(
      repairName(
        'TerryWhite Chemmart ...ears - 200ml',
        'https://terrywhitechemmart.com.au/shop/products/terrywhite-chemmart-paracetamol-pain-relief-children-5-12-years-200ml',
      ),
    ).toBe('TerryWhite Chemmart Paracetamol Pain Relief Children 5 12 Years 200ml');
    // A link that doesn't match the card is left alone.
    expect(repairName('Advil Ibuprofen 200m...uid capsules', 'https://x.com.au/p/123456')).toBe('Advil Ibuprofen 200m...uid capsules');
  });

  it('splits words the card ran together, where the link splits them', async () => {
    const { repairName } = await import('./webPage');
    expect(repairName('Hard Rated Lemon 10 PackCans 375ml', 'https://www.danmurphys.com.au/product/DM_1/hard-rated-lemon-10-pack-cans-375ml')).toBe(
      'Hard Rated Lemon 10 Pack Cans 375ml',
    );
    expect(repairName('ApoHealth Ibuprofen 96 Tablets', 'https://x.com.au/apohealth-ibuprofen-96-tablets')).toBe('ApoHealth Ibuprofen 96 Tablets');
  });

  it('takes prices and badges out of names', () => {
    expect(cleanName('Advil Ibuprofen 200mg $7.00')).toBe('Advil Ibuprofen 200mg');
    expect(cleanName('Nurofen 200mg - 48 tablets $14.99')).toBe('Nurofen 200mg - 48 tablets');
    expect(cleanName('16% OFF RRP∞Advil 40 Liquid Capsules')).toBe('Advil 40 Liquid Capsules');
  });

  it('finds lazy-loaded pictures and puts spaces between lines', () => {
    const html = `<html><body><ul>${[1, 2]
      .map(
        (n) =>
          `<li class="tile"><a href="/p/hard-rated-lemon-${n}"><img src="data:image/gif;base64,R0lG"><noscript><img src="/img/${n}.jpg"></noscript><h3><span>Hard Rated</span><span>Lemon<br>Cans 375ml</span></h3></a><span class="price">$23.00</span></li>`,
      )
      .join('')}</ul></body></html>`;
    const out = fromCards('danmurphys', html, 'https://www.danmurphys.com.au/search?q=x', parse);
    expect(out[0].name).toBe('Hard Rated Lemon Cans 375ml');
    expect(out[0].imageUrl).toBe('https://www.danmurphys.com.au/img/1.jpg');
  });
});
