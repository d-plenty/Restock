// The made-up items the sample set had before 0.13.0 (each built to show one thing: a fake special, a
// cheaper swap, member prices, flavours). The walkthrough uses real items now (demoData.ts); the tests
// that were written around these keep them.
import type { DemoGroup, DemoSet } from './demo';

const GROUPS: DemoGroup[] = [
  // 0.10.9: three scents of one thing at Coles (flavours, scents and colours): two on special.
  {
    key: 'wash',
    name: 'Body wash',
    category: 'Bathroom',
    usual: {
      key: 'wash-coles-honey',
      chain: 'coles',
      name: 'Body Wash Milk & Honey 1L (sample)',
      size: '1L',
      normal: 4.8,
      current: { price: 4.8 },
    },
    same: [
      {
        key: 'wash-coles-ocean',
        chain: 'coles',
        name: 'Body Wash Ocean Breeze 1L (sample)',
        size: '1L',
        normal: 4.8,
        current: { price: 3.3, special: true, was: 4.8 },
      },
      {
        key: 'wash-coles-guava',
        chain: 'coles',
        name: 'Body Wash Guava & Peach 1L (sample)',
        size: '1L',
        normal: 4.8,
        current: { price: 3.3, special: true, was: 4.8 },
      },
    ],
  },
  {
    key: 'paper',
    name: 'A4 copy paper',
    category: 'Pantry',
    usual: {
      key: 'paper-ww',
      chain: 'woolworths',
      name: 'A4 copy paper 500 sheets (sample)',
      size: '500 sheets',
      normal: 9,
      sales: { 20: 6.75, 12: 6.75, 6: 7.2 },
      current: { price: 4.5, special: true, was: 9, promo: '1/2 price' },
    },
    same: [
      {
        key: 'paper-coles',
        chain: 'coles',
        name: 'A4 copy paper 500 sheets (sample)',
        size: '500 sheets',
        normal: 8.5,
        current: { price: 8.5 },
      },
    ],
  },
  {
    key: 'tp',
    name: 'Toilet paper',
    category: 'Bathroom',
    usual: {
      key: 'tp-aldi',
      chain: 'aldi',
      name: 'Toilet paper 24 pack (sample)',
      size: '24 pack',
      normal: 5,
      current: { price: 5 },
    },
    alts: [
      {
        key: 'tp-coles',
        chain: 'coles',
        name: 'Coles toilet paper 24 pack (sample)',
        size: '24 pack',
        normal: 6,
        sales: { 15: 4.5 },
        current: { price: 3.5, special: true, was: 6, promo: 'Save $2.50' },
      },
      {
        key: 'tp-ww',
        chain: 'woolworths',
        name: 'Woolworths toilet paper 24 pack (sample)',
        size: '24 pack',
        normal: 6.2,
        current: { price: 6.2 },
      },
    ],
  },
  {
    key: 'coffee',
    name: 'Ground coffee 1kg',
    category: 'Pantry',
    usual: {
      key: 'coffee-coles',
      chain: 'coles',
      name: 'Ground coffee 1kg (sample)',
      size: '1kg',
      normal: 20,
      sales: { 24: 12, 18: 12, 12: 12, 6: 12 },
      current: { price: 15, special: true, was: 20, promo: 'Save $5' },
    },
  },
  {
    key: 'dish',
    name: 'Dishwasher tablets',
    category: 'Cleaning',
    usual: {
      key: 'dish-ww',
      chain: 'woolworths',
      name: 'Dishwasher tablets 60 pack (sample)',
      size: '60 pack',
      normal: 25,
      current: { price: 25, special: true, was: 27, promo: 'Special' },
    },
  },
  {
    key: 'laundry',
    name: 'Laundry liquid 2L',
    category: 'Cleaning',
    usual: {
      key: 'laundry-ww',
      chain: 'woolworths',
      name: 'Laundry liquid 2L (sample)',
      size: '2L',
      normal: 16,
      current: { price: 10, special: true, was: 16, member: true, promo: 'Member price' },
    },
  },
  {
    key: 'milk',
    name: 'Milk 2L',
    category: 'Fridge & freezer',
    usual: {
      key: 'milk-aldi',
      chain: 'aldi',
      name: 'Full cream milk 2L (sample)',
      size: '2L',
      normal: 3.1,
      current: { price: 3.1 },
    },
  },
  {
    key: 'pasta',
    name: 'Spaghetti 500g',
    category: 'Pantry',
    usual: {
      key: 'pasta-coles',
      chain: 'coles',
      name: 'Spaghetti 500g (sample)',
      size: '500g',
      normal: 2,
      current: { price: 1.8, special: true, was: 2, promo: 'Save 20c' },
    },
  },
];

export const FIXTURE: DemoSet = {
  groups: GROUPS,
  entries: [
    { id: 'demo-list-1', text: 'Bananas', chain: 'woolworths', category: 'Fridge & freezer' },
    { id: 'demo-list-2', text: 'Bin bags', category: 'Cleaning' },
  ],
};
