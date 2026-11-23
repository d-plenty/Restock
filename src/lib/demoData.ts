// 0.13.0: the walkthrough's items are real ones: twenty things from the makers' own pantry, with the
// products they buy at Coles, Woolworths and Aldi and the price each was at when this was made (an
// example price: it isn't checked). Ten of them go on the shopping list. Made from their own export.
import type { DemoGroup } from './demo';
export const DEMO_GROUPS: DemoGroup[] = [
 {
  "key": "full-cream-milk",
  "name": "Full cream milk",
  "category": "Fridge & freezer",
  "usual": {
   "key": "full-cream-milk-al",
   "chain": "aldi",
   "name": "Full Cream Milk 3L",
   "size": "3 l",
   "normal": 4.95,
   "current": {
    "price": 4.95
   },
   "brand": "FARMDALE",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/0fc1211c-ed08-4a72-a234-56a9e132cac6/farmdale-full-cream-milk-3l"
  },
  "same": [
   {
    "key": "full-cream-milk-wo",
    "chain": "woolworths",
    "name": "Woolworths Full Cream Milk 3L",
    "size": "3L",
    "normal": 4.95,
    "current": {
     "price": 4.95
    },
    "brand": "Woolworths",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/888140.jpg"
   },
   {
    "key": "full-cream-milk-co",
    "chain": "coles",
    "name": "Coles Full Cream Milk",
    "size": "3L",
    "normal": 4.95,
    "current": {
     "price": 4.95
    },
    "brand": "Coles",
    "imageUrl": "https://productimages.coles.com.au/productimages/8/8150288.jpg"
   }
  ]
 },
 {
  "key": "eggs",
  "name": "Eggs",
  "category": "Fridge & freezer",
  "usual": {
   "key": "eggs-al",
   "chain": "aldi",
   "name": "Free Range Eggs 700g",
   "size": "700 g",
   "normal": 6.19,
   "current": {
    "price": 6.19
   },
   "brand": "LODGE FARMS",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/b9e86a0c-1234-434e-a49b-f89db9144072/lodge-farms-free-range-eggs-700g"
  },
  "same": [
   {
    "key": "eggs-wo",
    "chain": "woolworths",
    "name": "Woolworths 12 Pack X Large Free Range Eggs 700g",
    "size": "700g",
    "normal": 6.7,
    "current": {
     "price": 6.7
    },
    "brand": "Woolworths",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/224763.jpg"
   },
   {
    "key": "eggs-co",
    "chain": "coles",
    "name": "Coles Free Range Eggs 12 Pack",
    "size": "700g",
    "normal": 6.7,
    "current": {
     "price": 6.7
    },
    "brand": "Coles",
    "imageUrl": "https://productimages.coles.com.au/productimages/9/9453478.jpg"
   }
  ]
 },
 {
  "key": "butter",
  "name": "Butter",
  "category": "Fridge & freezer",
  "usual": {
   "key": "butter-al",
   "chain": "aldi",
   "name": "Original Spread 500g",
   "size": "500 g",
   "normal": 3.29,
   "current": {
    "price": 3.29
   },
   "brand": "SUNNYVALE",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/b07438cc-be5f-4a44-afad-33a3c3b97e13/sunnyvale-original-spread-500g"
  },
  "same": [
   {
    "key": "butter-co",
    "chain": "coles",
    "name": "Meadow Lea Original Margarine Spread",
    "size": "500g",
    "normal": 4.5,
    "current": {
     "price": 4,
     "special": true,
     "was": 4.5
    },
    "brand": "Meadow Lea",
    "imageUrl": "https://productimages.coles.com.au/productimages/1/138074.jpg"
   },
   {
    "key": "butter-wo",
    "chain": "woolworths",
    "name": "Meadowlea Original Spread 500g",
    "size": "500g",
    "normal": 4.5,
    "current": {
     "price": 4.5
    },
    "brand": "Meadowlea",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/048016.jpg"
   }
  ]
 },
 {
  "key": "tasty-cheese",
  "name": "Tasty cheese",
  "category": "Fridge & freezer",
  "usual": {
   "key": "tasty-cheese-al",
   "chain": "aldi",
   "name": "Shredded Tasty Cheese 500g",
   "size": "500 g",
   "normal": 6.79,
   "current": {
    "price": 6.79
   },
   "brand": "WESTACRE DAIRY",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/ac4d85c5-f4d0-4873-8550-2213430d6c41/westacre-dairy-shredded-tasty-cheese-500g"
  },
  "same": [
   {
    "key": "tasty-cheese-wo",
    "chain": "woolworths",
    "name": "Woolworths Tasty Shredded Cheese 500g",
    "size": "500g",
    "normal": 8.3,
    "current": {
     "price": 8.3
    },
    "brand": "Woolworths",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/729026.jpg"
   },
   {
    "key": "tasty-cheese-al2",
    "chain": "aldi",
    "name": "Tasty Shredded Cheese 250g",
    "size": "250 g",
    "normal": 4.59,
    "current": {
     "price": 4.59
    },
    "brand": "WESTACRE DAIRY",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/171b7f30-896f-4217-bd2b-83deca5ad654/westacre-dairy-tasty-shredded-cheese-250g"
   },
   {
    "key": "tasty-cheese-al3",
    "chain": "aldi",
    "name": "Tasty Shredded Cheese 700g",
    "size": "700 g",
    "normal": 7.69,
    "current": {
     "price": 7.69
    },
    "brand": "WESTACRE DAIRY",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/10d9841a-5cac-4eb7-9f5c-2619774fb39d/westacre-dairy-tasty-shredded-cheese-700g"
   },
   {
    "key": "tasty-cheese-wo2",
    "chain": "woolworths",
    "name": "Woolworths Shredded Tasty Cheese 700g",
    "size": "700g",
    "normal": 10,
    "current": {
     "price": 10,
     "promo": "Was $10.50 - 07/10/2026"
    },
    "brand": "Woolworths",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/6044031.jpg"
   },
   {
    "key": "tasty-cheese-wo3",
    "chain": "woolworths",
    "name": "Hillview Tasty Shredded Cheese 700g",
    "size": "700g",
    "normal": 8.5,
    "current": {
     "price": 8.5,
     "promo": "Was $9.30 - 25/08/2026"
    },
    "brand": "Hillview",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/491820.jpg"
   },
   {
    "key": "tasty-cheese-co",
    "chain": "coles",
    "name": "Coles Cheese Shredded Tasty",
    "size": "700g",
    "normal": 10,
    "current": {
     "price": 10
    },
    "brand": "Coles",
    "imageUrl": "https://productimages.coles.com.au/productimages/8/8145335.jpg"
   }
  ]
 },
 {
  "key": "greek-yoghurt",
  "name": "Greek yoghurt",
  "category": "Fridge & freezer",
  "usual": {
   "key": "greek-yoghurt-al",
   "chain": "aldi",
   "name": "Light Greek Style Natural Yogurt 1kg",
   "size": "1 kg",
   "normal": 3.89,
   "current": {
    "price": 3.89
   },
   "brand": "LYTTOS",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/73e9de10-054a-481f-b1dd-ee0529397271/lyttos-light-greek-style-natural-yogurt-1kg"
  },
  "same": [
   {
    "key": "greek-yoghurt-wo",
    "chain": "woolworths",
    "name": "Woolworths Natural Greek Style Yoghurt 1kg",
    "size": "1kg",
    "normal": 4.2,
    "current": {
     "price": 4.2
    },
    "brand": "Woolworths",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/571487.jpg"
   },
   {
    "key": "greek-yoghurt-co",
    "chain": "coles",
    "name": "Coles Greek Style Yoghurt",
    "size": "1Kg",
    "normal": 4.5,
    "current": {
     "price": 4.5
    },
    "brand": "Coles",
    "imageUrl": "https://productimages.coles.com.au/productimages/1/1856561.jpg"
   }
  ]
 },
 {
  "key": "frozen-chips",
  "name": "Frozen Chips",
  "category": "Fridge & freezer",
  "usual": {
   "key": "frozen-chips-al",
   "chain": "aldi",
   "name": "Frozen Straight Cut Chips 1kg",
   "size": "1 kg",
   "normal": 2.99,
   "current": {
    "price": 2.99
   },
   "brand": "SEASONS PRIDE",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/a58ea14a-f3a8-4b71-8cf0-2424517151a4/seasons-pride-frozen-straight-cut-chips-1kg"
  },
  "same": [
   {
    "key": "frozen-chips-co",
    "chain": "coles",
    "name": "Coles Simply Straight Cut Chips",
    "size": "1Kg",
    "normal": 3.15,
    "current": {
     "price": 3.15
    },
    "brand": "Coles Simply",
    "imageUrl": "https://productimages.coles.com.au/productimages/6/6477470.jpg"
   },
   {
    "key": "frozen-chips-wo",
    "chain": "woolworths",
    "name": "Woolworths Essentials Straight Cut Chips 1kg",
    "size": "1kg",
    "normal": 3.15,
    "current": {
     "price": 3.15,
     "promo": "Range was $3.50 - 30/04/2026"
    },
    "brand": "Woolworths Essentials",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/640776.jpg"
   }
  ]
 },
 {
  "key": "pink-lady-apples",
  "name": "Pink Lady Apples",
  "category": "Pantry",
  "usual": {
   "key": "pink-lady-apples-co",
   "chain": "coles",
   "name": "Coles Pink Lady Apples Medium",
   "size": "approx. 200g each",
   "normal": 1.5,
   "current": {
    "price": 0.98,
    "special": true
   },
   "brand": "Coles",
   "imageUrl": "https://productimages.coles.com.au/productimages/5/5111654.jpg"
  },
  "same": [
   {
    "key": "pink-lady-apples-al",
    "chain": "aldi",
    "name": "Pink Lady Apples per kg",
    "size": "",
    "normal": 3.99,
    "current": {
     "price": 5.99
    },
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/195ba99f-fe84-46da-9117-ff2377f4041b/no-brand-pink-lady-apples-per-kg"
   },
   {
    "key": "pink-lady-apples-wo",
    "chain": "woolworths",
    "name": "Fresh Pink Lady Apples each",
    "size": "each",
    "normal": 0.86,
    "current": {
     "price": 1.31
    },
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/105919.jpg"
   }
  ]
 },
 {
  "key": "coca-cola",
  "name": "Coca-cola",
  "category": "Pantry",
  "usual": {
   "key": "coca-cola-wo",
   "chain": "woolworths",
   "name": "Coca-Cola Classic Soft Drink Cans 375mL x 30 pack",
   "size": "375mL x 30 pack",
   "normal": 32,
   "current": {
    "price": 32,
    "promo": "Range was $40 - 23/06/2026"
   },
   "brand": "Coca-Cola",
   "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/084552.jpg"
  },
  "same": [
   {
    "key": "coca-cola-co",
    "chain": "coles",
    "name": "Coca-Cola Classic Soft Drink Multipack Cans 375ml",
    "size": "30 Pack",
    "normal": 32,
    "current": {
     "price": 32
    },
    "brand": "Coca-Cola",
    "imageUrl": "https://productimages.coles.com.au/productimages/8/8464796.jpg"
   },
   {
    "key": "coca-cola-al",
    "chain": "aldi",
    "name": "Coke Classic 18x375ml",
    "size": "18 x 375 ml",
    "normal": 20.99,
    "current": {
     "price": 20.99
    },
    "brand": "COCA-COLA",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/0954ad45-a19a-47ea-b7c3-8b916fd5a9cc/coca-cola-coke-classic-18x375ml"
   },
   {
    "key": "coca-cola-co2",
    "chain": "coles",
    "name": "Coca-Cola Classic Soft Drink Multipack Cans 375ml",
    "size": "10 Pack",
    "normal": 23,
    "current": {
     "price": 11.5,
     "special": true,
     "was": 23
    },
    "brand": "Coca-Cola",
    "imageUrl": "https://productimages.coles.com.au/productimages/1/1849307.jpg"
   },
   {
    "key": "coca-cola-wo2",
    "chain": "woolworths",
    "name": "Coca-Cola Classic Soft Drink Cans 375mL x 10 pack",
    "size": "375mL x 10 pack",
    "normal": 23,
    "current": {
     "price": 23,
     "promo": "2 for $23.00 - $3.07/1L"
    },
    "brand": "Coca-Cola",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/793315.jpg"
   },
   {
    "key": "coca-cola-wo3",
    "chain": "woolworths",
    "name": "Coca-Cola Classic Soft Drink Cans 375mL x 24 pack",
    "size": "375mL x 24 pack",
    "normal": 45,
    "current": {
     "price": 27,
     "special": true,
     "was": 45
    },
    "brand": "Coca-Cola",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/042605.jpg"
   }
  ]
 },
 {
  "key": "crackers",
  "name": "Crackers",
  "category": "Pantry",
  "usual": {
   "key": "crackers-wo",
   "chain": "woolworths",
   "name": "Ritz Original Crackers 227g",
   "size": "227g",
   "normal": 3.5,
   "current": {
    "price": 1.75,
    "special": true,
    "was": 3.5,
    "promo": "1/2 price"
   },
   "brand": "Ritz",
   "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/261282.jpg"
  },
  "same": [
   {
    "key": "crackers-co",
    "chain": "coles",
    "name": "Ritz Original Crackers",
    "size": "227g",
    "normal": 3.5,
    "current": {
     "price": 3.5,
     "special": true,
     "promo": "Pick any 2 for $5.60"
    },
    "brand": "Ritz",
    "imageUrl": "https://productimages.coles.com.au/productimages/6/6164463.jpg"
   },
   {
    "key": "crackers-al",
    "chain": "aldi",
    "name": "Topz Original Crackers 227g",
    "size": "227 g",
    "normal": 2.29,
    "current": {
     "price": 2.29
    },
    "brand": "DAMORA",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/ed40d84d-7b0d-429b-b735-9cea4f2b9933/damora-topz-original-crackers-227g"
   }
  ]
 },
 {
  "key": "nutella",
  "name": "Nutella",
  "category": "Pantry",
  "usual": {
   "key": "nutella-al",
   "chain": "aldi",
   "name": "Nutella 400g",
   "size": "400 g",
   "normal": 6.69,
   "current": {
    "price": 6.69
   },
   "brand": "FERRERO",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/fb6cf6e2-54f8-4b05-a8c0-f06af2a6ef2b/ferrero-nutella-400g"
  },
  "same": [
   {
    "key": "nutella-wo",
    "chain": "woolworths",
    "name": "Nutella Hazelnut Chocolate Spread 400g",
    "size": "400g",
    "normal": 6.7,
    "current": {
     "price": 6.7
    },
    "brand": "Nutella",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/147312.jpg"
   },
   {
    "key": "nutella-wo2",
    "chain": "woolworths",
    "name": "Nutella Hazelnut Chocolate Spread 750g",
    "size": "750g",
    "normal": 12.5,
    "current": {
     "price": 12.5
    },
    "brand": "Nutella",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/147314.jpg"
   },
   {
    "key": "nutella-co",
    "chain": "coles",
    "name": "Nutella Hazelnut Chocolate Spread",
    "size": "400g",
    "normal": 6.7,
    "current": {
     "price": 6.7
    },
    "brand": "Nutella",
    "imageUrl": "https://productimages.coles.com.au/productimages/9/9032651.jpg"
   },
   {
    "key": "nutella-wo3",
    "chain": "woolworths",
    "name": "Nutella Hazelnut Chocolate Spread 1kg",
    "size": "1kg",
    "normal": 14.8,
    "current": {
     "price": 14.8
    },
    "brand": "Nutella",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/795889.jpg"
   },
   {
    "key": "nutella-co2",
    "chain": "coles",
    "name": "Nutella Hazelnut Chocolate Spread",
    "size": "1Kg",
    "normal": 14.8,
    "current": {
     "price": 14.8
    },
    "brand": "Nutella",
    "imageUrl": "https://productimages.coles.com.au/productimages/2/2620684.jpg"
   },
   {
    "key": "nutella-co3",
    "chain": "coles",
    "name": "Nutella Hazelnut Chocolate Spread",
    "size": "750g",
    "normal": 12.5,
    "current": {
     "price": 10,
     "special": true,
     "was": 12.5
    },
    "brand": "Nutella",
    "imageUrl": "https://productimages.coles.com.au/productimages/6/6690772.jpg"
   }
  ]
 },
 {
  "key": "vegemite",
  "name": "Vegemite",
  "category": "Pantry",
  "usual": {
   "key": "vegemite-wo",
   "chain": "woolworths",
   "name": "Vegemite Spread 560g",
   "size": "560g",
   "normal": 9.9,
   "current": {
    "price": 9.9
   },
   "brand": "Vegemite",
   "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/280512.jpg"
  },
  "same": [
   {
    "key": "vegemite-co",
    "chain": "coles",
    "name": "Vegemite Spread",
    "size": "560g",
    "normal": 9.9,
    "current": {
     "price": 9.9
    },
    "brand": "Vegemite",
    "imageUrl": "https://productimages.coles.com.au/productimages/6/6027622.jpg"
   },
   {
    "key": "vegemite-al",
    "chain": "aldi",
    "name": "Vegemite 370g",
    "size": "370 g",
    "normal": 7.19,
    "current": {
     "price": 7.19
    },
    "brand": "VEGEMITE",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/337da526-9930-4295-ba56-962abbf61e72/vegemite-vegemite-370g"
   },
   {
    "key": "vegemite-wo2",
    "chain": "woolworths",
    "name": "Vegemite Spread 380g",
    "size": "380g",
    "normal": 7.7,
    "current": {
     "price": 7.7
    },
    "brand": "Vegemite",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/796439.jpg"
   },
   {
    "key": "vegemite-co2",
    "chain": "coles",
    "name": "Vegemite Spread",
    "size": "380g",
    "normal": 7.7,
    "current": {
     "price": 7.7
    },
    "brand": "Vegemite",
    "imageUrl": "https://productimages.coles.com.au/productimages/5/5998852.jpg"
   }
  ]
 },
 {
  "key": "peanut-butter",
  "name": "Peanut butter",
  "category": "Pantry",
  "usual": {
   "key": "peanut-butter-al",
   "chain": "aldi",
   "name": "Smooth Peanut Butter 500g",
   "size": "500 g",
   "normal": 2.99,
   "current": {
    "price": 2.99
   },
   "brand": "BRAMWELLS",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/0ede6aca-a5dd-46a1-a849-9575d5ef40b3/bramwells-smooth-peanut-butter-500g"
  },
  "same": [
   {
    "key": "peanut-butter-wo",
    "chain": "woolworths",
    "name": "Woolworths Smooth Peanut Butter 500g",
    "size": "500g",
    "normal": 3,
    "current": {
     "price": 3,
     "promo": "Range was $3.20 - 09/11/2026"
    },
    "brand": "Woolworths",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/233922.jpg"
   },
   {
    "key": "peanut-butter-co",
    "chain": "coles",
    "name": "Coles Peanut Butter Smooth",
    "size": "500g",
    "normal": 3,
    "current": {
     "price": 3
    },
    "brand": "Coles",
    "imageUrl": "https://productimages.coles.com.au/productimages/8/8100621.jpg"
   }
  ]
 },
 {
  "key": "passata",
  "name": "Passata",
  "category": "Pantry",
  "usual": {
   "key": "passata-al",
   "chain": "aldi",
   "name": "Authentic Italian Passata 700g",
   "size": "700 g",
   "normal": 1.89,
   "current": {
    "price": 1.89
   },
   "brand": "REMANO",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/0a72d835-d24a-4a96-b11f-1a409b9f6fde/remano-authentic-italian-passata-700g"
  },
  "same": [
   {
    "key": "passata-co",
    "chain": "coles",
    "name": "Coles Italian Passata Sauce",
    "size": "700g",
    "normal": 2,
    "current": {
     "price": 2
    },
    "brand": "Coles",
    "imageUrl": "https://productimages.coles.com.au/productimages/5/5419718.jpg"
   },
   {
    "key": "passata-wo",
    "chain": "woolworths",
    "name": "Classic Italia Tomato Passata 700g",
    "size": "700g",
    "normal": 2.75,
    "current": {
     "price": 1.9,
     "special": true,
     "was": 2.75
    },
    "brand": "Classic Italia",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/065395.jpg"
   }
  ]
 },
 {
  "key": "mayonnaise",
  "name": "Mayonnaise",
  "category": "Pantry",
  "usual": {
   "key": "mayonnaise-al",
   "chain": "aldi",
   "name": "Authentic Mayonnaise Squeeze 475g",
   "size": "475 g",
   "normal": 3.69,
   "current": {
    "price": 3.69
   },
   "brand": "COLWAY",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/e7ee855b-33c6-4dbb-b0af-9a6b8d21445c/colway-authentic-mayonnaise-squeeze-475g"
  },
  "same": [
   {
    "key": "mayonnaise-co",
    "chain": "coles",
    "name": "Praise Squeeze Whole Egg Mayonnaise",
    "size": "230g",
    "normal": 4.5,
    "current": {
     "price": 4.5,
     "member": true,
     "promo": "Triple points"
    },
    "brand": "Praise",
    "imageUrl": "https://productimages.coles.com.au/productimages/8/8985981.jpg"
   },
   {
    "key": "mayonnaise-wo",
    "chain": "woolworths",
    "name": "Praise Whole Egg Creamy Mayo 230g",
    "size": "230g",
    "normal": 4.5,
    "current": {
     "price": 3,
     "special": true,
     "was": 4.5
    },
    "brand": "Praise",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/926813.jpg"
   }
  ]
 },
 {
  "key": "sweet-chilli-sauce",
  "name": "Sweet chilli sauce",
  "category": "Pantry",
  "usual": {
   "key": "sweet-chilli-sauce-al",
   "chain": "aldi",
   "name": "Sweet Chilli Sauce 700ml",
   "size": "700 ml",
   "normal": 2.49,
   "current": {
    "price": 2.49
   },
   "brand": "ASIA GREEN GARDEN",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/2c127d27-caf2-4bc6-a682-1de165e86b0c/asia-green-garden-sweet-chilli-sauce-700ml"
  },
  "same": [
   {
    "key": "sweet-chilli-sauce-wo",
    "chain": "woolworths",
    "name": "Fountain Sweet Chilli Sauce 250mL",
    "size": "250mL",
    "normal": 3.8,
    "current": {
     "price": 3,
     "special": true,
     "was": 3.8
    },
    "brand": "Fountain",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/047106.jpg"
   },
   {
    "key": "sweet-chilli-sauce-co",
    "chain": "coles",
    "name": "Fountain Sweet Chilli Sauce",
    "size": "250mL",
    "normal": 3.8,
    "current": {
     "price": 3.8,
     "special": true,
     "promo": "Pick any 2 for $6"
    },
    "brand": "Fountain",
    "imageUrl": "https://productimages.coles.com.au/productimages/6/6849199.jpg"
   }
  ]
 },
 {
  "key": "tomato-sauce",
  "name": "Tomato sauce",
  "category": "Pantry",
  "usual": {
   "key": "tomato-sauce-wo",
   "chain": "woolworths",
   "name": "Fountain Tomato Sauce Value Pack 2L",
   "size": "2L",
   "normal": 6,
   "current": {
    "price": 6
   },
   "brand": "Fountain",
   "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/175901.jpg"
  },
  "same": [
   {
    "key": "tomato-sauce-al",
    "chain": "aldi",
    "name": "Tomato Sauce 2L",
    "size": "2 l",
    "normal": 4.99,
    "current": {
     "price": 4.99
    },
    "brand": "COLWAY",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/ff185002-a906-4418-9c5c-6c533adc5a00/colway-tomato-sauce-2l"
   },
   {
    "key": "tomato-sauce-co",
    "chain": "coles",
    "name": "Fountain Tomato Sauce Value Pack",
    "size": "2L",
    "normal": 6,
    "current": {
     "price": 6
    },
    "brand": "Fountain",
    "imageUrl": "https://productimages.coles.com.au/productimages/7/7265171.jpg"
   }
  ]
 },
 {
  "key": "olive-oil",
  "name": "Olive oil",
  "category": "Pantry",
  "usual": {
   "key": "olive-oil-wo",
   "chain": "woolworths",
   "name": "Woolworths Essentials Olive Oil 1L",
   "size": "1L",
   "normal": 9.5,
   "current": {
    "price": 9.5,
    "promo": "Was $10 - 25/08/2026"
   },
   "brand": "Woolworths Essentials",
   "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/698861.jpg"
  },
  "same": [
   {
    "key": "olive-oil-co",
    "chain": "coles",
    "name": "Coles Simply Olive Oil",
    "size": "1L",
    "normal": 9.5,
    "current": {
     "price": 9.5
    },
    "brand": "Coles Simply",
    "imageUrl": "https://productimages.coles.com.au/productimages/3/3401493.jpg"
   },
   {
    "key": "olive-oil-al",
    "chain": "aldi",
    "name": "Olive Oil 1L",
    "size": "1 l",
    "normal": 8.79,
    "current": {
     "price": 8.79
    },
    "brand": "THE OLIVE TREE",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/67e279e8-a6f7-4121-a973-51b247c20f2e/the-olive-tree-olive-oil-1l"
   }
  ]
 },
 {
  "key": "toilet-tissue",
  "name": "Toilet Tissue",
  "category": "Bathroom",
  "usual": {
   "key": "toilet-tissue-al",
   "chain": "aldi",
   "name": "Toilet Tissue 3 Ply 24 Pack",
   "size": "4,320 sheets",
   "normal": 8.39,
   "current": {
    "price": 8.39
   },
   "brand": "CONFIDENCE",
   "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/4bf689a6-9c8f-45db-878d-063f3cd04fd1/confidence-toilet-tissue-3-ply-24-pack"
  },
  "same": [
   {
    "key": "toilet-tissue-al2",
    "chain": "aldi",
    "name": "Toilet Tissue Double Length 3 Ply 4 Pack",
    "size": "1,440 sheets",
    "normal": 3.59,
    "current": {
     "price": 3.59
    },
    "brand": "CONFIDENCE",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/a49637a6-8c4f-4440-b83c-820397d02e9c/confidence-toilet-tissue-double-length-3-ply-4-pack"
   },
   {
    "key": "toilet-tissue-al3",
    "chain": "aldi",
    "name": "Toilet Tissue Hypoallergenic 4 Ply 8 Pack",
    "size": "1,120 sheets",
    "normal": 4.99,
    "current": {
     "price": 4.99
    },
    "brand": "CONFIDENCE",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/08308b83-3cbf-45f1-8394-f2df95916841/confidence-toilet-tissue-hypoallergenic-4-ply-8-pack"
   },
   {
    "key": "toilet-tissue-al4",
    "chain": "aldi",
    "name": "Toilet Tissue Double Length 3 Ply 8 Pack",
    "size": "2,880 sheets",
    "normal": 6.99,
    "current": {
     "price": 6.99
    },
    "brand": "CONFIDENCE",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/13a4f8d7-7eef-4b18-b6ea-2146f77a0af0/confidence-toilet-tissue-double-length-3-ply-8-pack"
   },
   {
    "key": "toilet-tissue-co",
    "chain": "coles",
    "name": "Quilton 3 Ply Unscented White Toilet Paper",
    "size": "12 Pack",
    "normal": 8.5,
    "current": {
     "price": 8.5,
     "promo": "Bonus collectable"
    },
    "brand": "Quilton",
    "imageUrl": "https://productimages.coles.com.au/productimages/5/5034134.jpg"
   },
   {
    "key": "toilet-tissue-wo",
    "chain": "woolworths",
    "name": "Quilton White 3 Ply Toilet Paper 48 pack",
    "size": "48 pack",
    "normal": 23,
    "current": {
     "price": 23,
     "promo": "Buy 1 get a bonus Container credit^"
    },
    "brand": "Quilton",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/165930.jpg"
   },
   {
    "key": "toilet-tissue-co2",
    "chain": "coles",
    "name": "Quilton Toilet Paper Classic White 20 Pack",
    "size": "3600 Sheet",
    "normal": 11.5,
    "current": {
     "price": 11.5,
     "special": true,
     "promo": "Buy 2 for $20"
    },
    "brand": "Quilton",
    "imageUrl": "https://productimages.coles.com.au/productimages/7/7758634.jpg"
   },
   {
    "key": "toilet-tissue-wo2",
    "chain": "woolworths",
    "name": "Quilton White 3 Ply Toilet Paper 24 pack",
    "size": "24 pack",
    "normal": 13.8,
    "current": {
     "price": 13.8,
     "promo": "Buy 1 get a bonus Container credit^"
    },
    "brand": "Quilton",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/851925.jpg"
   },
   {
    "key": "toilet-tissue-wo3",
    "chain": "woolworths",
    "name": "Quilton Prints 3 Ply Toilet Paper 24 pack",
    "size": "24 pack",
    "normal": 13.8,
    "current": {
     "price": 13.8,
     "promo": "Buy 1 get a bonus Container credit^"
    },
    "brand": "Quilton",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/852042.jpg"
   },
   {
    "key": "toilet-tissue-wo4",
    "chain": "woolworths",
    "name": "icare 100% Recycled Luxury 3 Ply Toilet Tissue 8 pack",
    "size": "8 pack",
    "normal": 8,
    "current": {
     "price": 8
    },
    "brand": "icare",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/847655.jpg"
   },
   {
    "key": "toilet-tissue-wo5",
    "chain": "woolworths",
    "name": "icare 100% Recycled Double Length 3 Ply Toilet Tissue 6 pack",
    "size": "6 pack",
    "normal": 7.9,
    "current": {
     "price": 7.9
    },
    "brand": "icare",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/847649.jpg"
   }
  ]
 },
 {
  "key": "dishwashing-liquid",
  "name": "Dishwashing liquid",
  "category": "Cleaning",
  "usual": {
   "key": "dishwashing-liquid-wo",
   "chain": "woolworths",
   "name": "Earth Choice Dishwashing Liquid 1L",
   "size": "1L",
   "normal": 2.65,
   "current": {
    "price": 2.65
   },
   "brand": "Earth Choice",
   "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/010432.jpg"
  },
  "same": [
   {
    "key": "dishwashing-liquid-co",
    "chain": "coles",
    "name": "Earth Choice Dishwashing Liquid",
    "size": "1L",
    "normal": 2.65,
    "current": {
     "price": 2.65
    },
    "brand": "Earth Choice",
    "imageUrl": "https://productimages.coles.com.au/productimages/5/5417360.jpg"
   },
   {
    "key": "dishwashing-liquid-al",
    "chain": "aldi",
    "name": "Assorted Dishwashing Liquid 500ml",
    "size": "500 ml",
    "normal": 2.79,
    "current": {
     "price": 2.79
    },
    "brand": "GREEN ACTION",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/300/570cd0d5-b678-486f-a5d7-89f1593fed4e/green-action-assorted-dishwashing-liquid-500ml"
   },
   {
    "key": "dishwashing-liquid-wo2",
    "chain": "woolworths",
    "name": "Earth Choice Dishwashing Liquid 900mL",
    "size": "900mL",
    "normal": 6,
    "current": {
     "price": 6
    },
    "brand": "Earth Choice",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/753871.jpg"
   },
   {
    "key": "dishwashing-liquid-wo3",
    "chain": "woolworths",
    "name": "Earth Choice Lemon Burst Dishwash 500mL",
    "size": "500mL",
    "normal": 3.6,
    "current": {
     "price": 2.5,
     "special": true,
     "was": 3.6
    },
    "brand": "Earth Choice",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/040124.jpg"
   },
   {
    "key": "dishwashing-liquid-wo4",
    "chain": "woolworths",
    "name": "Earth Choice Dishwashing Liquid Green Tea & Lime 500mL",
    "size": "500mL",
    "normal": 3.6,
    "current": {
     "price": 2.5,
     "special": true,
     "was": 3.6
    },
    "brand": "Earth Choice",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/medium/227264.jpg"
   }
  ]
 },
 {
  "key": "toilet-block",
  "name": "Toilet block",
  "category": "Cleaning",
  "usual": {
   "key": "toilet-block-co",
   "chain": "coles",
   "name": "Bref Blue Active Toilet Cleaner Rim Block Eucalyptus 2x50g",
   "size": "100g",
   "normal": 11,
   "current": {
    "price": 11
   },
   "brand": "Bref",
   "imageUrl": "https://productimages.coles.com.au/productimages/3/3744707.jpg"
  },
  "same": [
   {
    "key": "toilet-block-wo",
    "chain": "woolworths",
    "name": "Bref Self Active Eucalyptus Toilet Cleaner Block 3 pack",
    "size": "3 pack",
    "normal": 8.5,
    "current": {
     "price": 8.5
    },
    "brand": "Bref",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/141468.jpg"
   },
   {
    "key": "toilet-block-co2",
    "chain": "coles",
    "name": "Bref Blue Active Rim Block Eucalyptus Toilet Cleaner",
    "size": "50g",
    "normal": 7,
    "current": {
     "price": 3.5,
     "special": true,
     "was": 7
    },
    "brand": "Bref",
    "imageUrl": "https://productimages.coles.com.au/productimages/3/3032819.jpg"
   },
   {
    "key": "toilet-block-wo2",
    "chain": "woolworths",
    "name": "Bref Self Active Eucalyptus Toilet Cleaner Block 1 pack",
    "size": "1 pack",
    "normal": 7,
    "current": {
     "price": 7
    },
    "brand": "Bref",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/624144.jpg"
   },
   {
    "key": "toilet-block-wo3",
    "chain": "woolworths",
    "name": "Bref Blue Active Eucalyptus Toilet Cleaner Block 2 pack",
    "size": "2 pack",
    "normal": 11,
    "current": {
     "price": 5,
     "special": true,
     "was": 11,
     "promo": "1/2 price"
    },
    "brand": "Bref",
    "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/large/134075.jpg"
   },
   {
    "key": "toilet-block-al",
    "chain": "aldi",
    "name": "Toilet Rim Blocks Eucalyptus 2 x 50g",
    "size": "100 g",
    "normal": 3.29,
    "current": {
     "price": 3.29
    },
    "brand": "POWER FORCE",
    "imageUrl": "https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/23d90719-baf7-4d21-9b93-342832012b01/power-force-toilet-rim-blocks-eucalyptus-2-x-50g"
   }
  ]
 }
];
/** The ones that start on the shopping list. */
export const DEMO_LIST: string[] = ["full-cream-milk","eggs","butter","tasty-cheese","pink-lady-apples","coca-cola","crackers","passata","toilet-tissue","dishwashing-liquid"];
