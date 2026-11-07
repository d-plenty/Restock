import { SHOPS, shopDef, type Section, type StoreChain } from '../shops';
import { APP_UA, num, request, sleep } from '../stores/http';

// Finding nearby stores, using OpenStreetMap's free public services from this phone:
//  - Nominatim turns a suburb or postcode into a map position.
//  - Overpass lists the supermarkets, bottle shops or pharmacies around that position.
// No Google services and no account. Map data © OpenStreetMap contributors.

export interface Area {
  label: string;
  lat: number;
  lon: number;
}

export interface NearbyStore {
  chain: StoreChain;
  name: string;
  address?: string;
  lat: number;
  lon: number;
  km: number;
  /** The map's own id for this branch ("node/123"), so two branches with the same name are never confused. */
  id?: string;
  /** The shop's own store number, when the map has it (Coles: the number on its store page). */
  storeNo?: string;
  /** Which way it is from where you searched: "north-east". */
  dir?: string;
  /** A note, like "Listed on the map as First Choice Liquor". */
  note?: string;
}

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** Compass direction from one point to another, in words. */
export function directionWord(aLat: number, aLon: number, bLat: number, bLon: number): string {
  const y = Math.sin(((bLon - aLon) * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180);
  const x =
    Math.cos((aLat * Math.PI) / 180) * Math.sin((bLat * Math.PI) / 180) -
    Math.sin((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.cos(((bLon - aLon) * Math.PI) / 180);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return DIRS[Math.round(deg / 45) % 8];
}

const HEADERS = { Accept: 'application/json', 'User-Agent': APP_UA };

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

type Raw = Record<string, unknown>;

export function parseAreas(data: unknown): Area[] {
  if (!Array.isArray(data)) return [];
  const out: Area[] = [];
  for (const r of data as Raw[]) {
    const lat = num(r.lat);
    const lon = num(r.lon);
    if (lat === undefined || lon === undefined) continue;
    const a = (r.address ?? {}) as Record<string, string>;
    const place = a.suburb ?? a.town ?? a.city_district ?? a.village ?? a.city ?? a.hamlet ?? a.municipality;
    const state = STATE_ABBR[a.state ?? ''] ?? a.state;
    const label =
      [place, state, a.postcode].filter(Boolean).join(' ') ||
      String(r.display_name ?? '')
        .split(',')
        .slice(0, 3)
        .join(',');
    if (!out.some((o) => o.label === label)) out.push({ label, lat, lon });
  }
  return out;
}

const STATE_ABBR: Record<string, string> = {
  Queensland: 'QLD',
  'New South Wales': 'NSW',
  Victoria: 'VIC',
  Tasmania: 'TAS',
  'South Australia': 'SA',
  'Western Australia': 'WA',
  'Northern Territory': 'NT',
  'Australian Capital Territory': 'ACT',
};

const FAKE_NEAR: Record<Section, [StoreChain, string, number][]> = {
  pantry: [
    ['woolworths', 'Woolworths Bohle Plains', 1.2],
    ['coles', 'Coles Kirwan', 3.4],
    ['aldi', 'Aldi Kirwan', 3.6],
    ['coles', 'Coles Willows', 5.8],
  ],
  keg: [
    ['bws', 'BWS Bohle Plains', 1.3],
    ['liquorlandwarehouse', 'Liquorland Warehouse Kirwan', 3.5],
    ['danmurphys', "Dan Murphy's Thuringowa", 4.1],
    ['bws', 'BWS Kirwan', 4.4],
    ['bottleo', 'The Bottle-O Condon', 5.2],
    ['thirstycamel', 'Thirsty Camel Kelso', 6.0],
    ['liquorland', 'Liquorland Cranbrook', 6.8],
    ['liquorland', 'Liquorland Aitkenvale', 6.9],
    ['danmurphys', "Dan Murphy's Aitkenvale", 8.0],
    ['danmurphys', "Dan Murphy's Garbutt", 7.8],
    ['bws', 'BWS Rasmussen', 8.1],
    ['bws', 'BWS Kelso', 10],
  ],
  pharmacy: [
    ['chemistwarehouse', 'Chemist Warehouse Kirwan', 3.3],
    ['terrywhite', 'TerryWhite Chemmart Willows', 5.7],
    ['priceline', 'Priceline Pharmacy Stockland', 9.4],
    ['amcal', 'Amcal Aitkenvale', 11.2],
  ],
};
function fakeNearby(section: Section, lat: number, lon: number): NearbyStore[] {
  return FAKE_NEAR[section].map(([chain, name, km]) => ({ chain, name, km, lat, lon, address: name.split(' ').slice(-1)[0] }));
}

/** Suburb or postcode → places in Australia. */
export async function searchArea(text: string): Promise<Area[]> {
  if (import.meta.env.VITE_FAKE_STORES === '1') return [{ label: 'Bohle Plains QLD 4817', lat: -19.31, lon: 146.69 }];
  const q = text.trim();
  if (!q) return [];
  const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', countrycodes: 'au', limit: '6' });
  if (/^\d{4}$/.test(q)) params.set('postalcode', q);
  else params.set('q', q);
  const res = await request({ url: `https://nominatim.openstreetmap.org/search?${params}`, headers: HEADERS });
  if (res.status >= 400) throw new Error(`The place search isn't answering (HTTP ${res.status}). Try again in a minute.`);
  return parseAreas(JSON.parse(res.text));
}

/** A readable name for a position, e.g. "Bohle Plains QLD 4817". */
export async function describePosition(lat: number, lon: number): Promise<string> {
  const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', lat: String(lat), lon: String(lon), zoom: '14' });
  try {
    const res = await request({ url: `https://nominatim.openstreetmap.org/reverse?${params}`, headers: HEADERS });
    return parseAreas([JSON.parse(res.text)])[0]?.label ?? 'Your location';
  } catch {
    return 'Your location';
  }
}

/** Which shop a map entry is, among the shops in a section (or all of them). */
export function chainOf(tags: Record<string, string>, section?: Section): StoreChain | undefined {
  const s = `${tags.brand ?? ''} ${tags.name ?? ''} ${tags.operator ?? ''}`;
  // More specific names first, so "Liquorland Warehouse" isn't read as plain Liquorland.
  const shops = SHOPS.filter((d) => !section || d.section === section).sort((a, b) => b.name.length - a.name.length);
  for (const d of shops) if (d.map.test(s)) return d.id;
  return undefined;
}

export function parseStores(data: unknown, from: { lat: number; lon: number }, section?: Section): NearbyStore[] {
  const els = ((data as Raw)?.elements ?? []) as Raw[];
  const out: NearbyStore[] = [];
  for (const e of els) {
    const tags = (e.tags ?? {}) as Record<string, string>;
    const centre = (e.center ?? e) as Raw;
    const lat = num(centre.lat);
    const lon = num(centre.lon);
    const chain = chainOf(tags, section);
    if (!chain || lat === undefined || lon === undefined) continue;
    const suburb = tags['addr:suburb'] ?? tags['addr:city'];
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    const brandName = shopDef(chain)?.name ?? chain;
    let name = tags.name ?? brandName;
    // OSM often names a store just "Coles"; add the suburb or a branch name to tell them apart.
    const branch = tags.branch ?? suburb;
    // OSM often names a store just "Liquorland", "cellarbrations" or "BottleO": use the shop's
    // proper name, plus the branch or suburb to tell them apart.
    const bare =
      squash(name) === squash(brandName) || squash(brandName).endsWith(squash(name)) || squash(name) === squash(brandName.replace(/^the /i, ''));
    if (bare) name = branch ? `${brandName} ${branch}` : brandName;
    // First Choice Liquor Market stores were renamed Liquorland Warehouse; the map often still has the old name.
    let note: string | undefined;
    if (chain === 'liquorlandwarehouse' && /first choice/i.test(name)) {
      note = `Listed on the map as ${name.replace(/liquour/i, 'Liquor')}`;
      name = branch ? `${brandName} ${branch}` : brandName;
    }
    out.push({
      chain,
      name,
      address: [street, suburb].filter(Boolean).join(', ') || undefined,
      lat,
      lon,
      km: distanceKm(from.lat, from.lon, lat, lon),
      id: e.type && e.id !== undefined ? `${String(e.type)}/${String(e.id)}` : undefined,
      storeNo: storeNumber(tags),
      dir: directionWord(from.lat, from.lon, lat, lon),
      note,
    });
  }
  return out.sort((a, b) => a.km - b.km);
}

/** A store number from the map's tags ("ref:coles" or a plain numeric "ref"), if it has one. */
function storeNumber(tags: Record<string, string>): string | undefined {
  for (const k of ['ref:coles', 'ref:store', 'ref:branch', 'ref']) {
    const v = tags[k]?.trim();
    if (v && /^\d{3,5}$/.test(v)) return v;
  }
  return undefined;
}

/** Every supermarket, bottle shop or pharmacy nearby; the chains are picked out on the phone. Plain tag lookups keep this fast. */
export function overpassQuery(lat: number, lon: number, metres: number, section: Section = 'pantry'): string {
  const at = `(around:${metres},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const what =
    section === 'keg'
      ? `nwr["shop"~"^(alcohol|wine|beverages)$"]${at};`
      : section === 'pharmacy'
        ? `(nwr["amenity"="pharmacy"]${at};nwr["shop"="chemist"]${at};);`
        : `nwr["shop"="supermarket"]${at};`;
  return `[out:json][timeout:20];${what}out center tags 300;`;
}

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const RADIUS_M = 25_000;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function dedupe(all: NearbyStore[]): NearbyStore[] {
  // Drop duplicates (a store mapped as both a point and a building).
  const out: NearbyStore[] = [];
  for (const s of all) if (!out.some((x) => x.chain === s.chain && distanceKm(x.lat, x.lon, s.lat, s.lon) < 0.15)) out.push(s);
  return uniqueNames(out);
}

/**
 * Your store is saved by its name, so two branches with the same name would both light up when
 * one is picked. Give any repeats something to tell them apart: the street, or how far away.
 */
export function uniqueNames(list: NearbyStore[]): NearbyStore[] {
  const count = new Map<string, number>();
  for (const s of list) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  const streetOf = (s: NearbyStore, withNumber: boolean) => {
    const first = s.address?.split(',')[0]?.trim();
    if (!first) return undefined;
    return withNumber ? first : first.replace(/^\d+[a-z]?(?:[-/]\d+[a-z]?)?\s+/i, '').trim() || undefined;
  };
  // Same name: add the street; if they're on the same street, the street number ("36 Thuringowa
  // Drive"); else which way it is ("Liquorland, north-east"). The distance is shown on its own
  // line, so it isn't repeated in the name.
  const out = list.map((s) => {
    if ((count.get(s.name) ?? 0) < 2) return s;
    const twins = list.filter((x) => x.name === s.name);
    for (const withNumber of [false, true]) {
      const mine = streetOf(s, withNumber);
      if (mine && twins.filter((x) => streetOf(x, withNumber) === mine).length === 1) return { ...s, name: `${s.name} (${mine})` };
    }
    if (s.dir && twins.filter((x) => x.dir === s.dir).length === 1) return { ...s, name: `${s.name}, ${s.dir}` };
    return s;
  });
  // Still the same? Number them, closest first.
  const again = new Map<string, number>();
  for (const s of out) again.set(s.name, (again.get(s.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return out.map((s) => {
    if ((again.get(s.name) ?? 0) < 2) return s;
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    return { ...s, name: `${s.name} #${n}` };
  });
}

async function overpassFrom(base: string, lat: number, lon: number, section: Section): Promise<NearbyStore[]> {
  const res = await request({
    url: `${base}?data=${encodeURIComponent(overpassQuery(lat, lon, RADIUS_M, section))}`,
    headers: HEADERS,
    timeoutMs: 25_000,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const data = JSON.parse(res.text) as Raw;
  // A busy server answers "200 OK" with a remark instead of results.
  if (typeof data.remark === 'string' && /error|timed out/i.test(data.remark)) throw new Error('map server busy');
  return dedupe(parseStores(data, { lat, lon }, section));
}

/** Backup: ask Nominatim for each chain's name inside a box around you. */
export async function nominatimStores(lat: number, lon: number, section: Section = 'pantry', chains?: StoreChain[]): Promise<NearbyStore[]> {
  const d = 0.25; // about 25 km
  const viewbox = [lon - d, lat + d, lon + d, lat - d].map((n) => n.toFixed(4)).join(',');
  const all: NearbyStore[] = [];
  const brands = (chains ?? SHOPS.filter((x) => x.section === section).map((x) => x.id))
    .map((c) => shopDef(c)?.name)
    .filter((x): x is string => !!x)
    .slice(0, 8);
  for (const brand of brands) {
    const params = new URLSearchParams({
      q: brand,
      format: 'jsonv2',
      addressdetails: '1',
      extratags: '1',
      countrycodes: 'au',
      viewbox,
      bounded: '1',
      limit: '20',
    });
    const res = await request({ url: `https://nominatim.openstreetmap.org/search?${params}`, headers: HEADERS, timeoutMs: 15_000 });
    if (res.status < 400) {
      const rows = JSON.parse(res.text) as Raw[];
      const elements = rows
        .filter(
          (r) =>
            r.type === 'supermarket' ||
            r.type === 'alcohol' ||
            r.type === 'pharmacy' ||
            r.type === 'chemist' ||
            r.category === 'shop' ||
            r.category === 'amenity',
        )
        .map((r) => {
          const a = (r.address ?? {}) as Record<string, string>;
          return {
            // The map's own id, so a branch found by name is the same branch as on the map.
            type: r.osm_type,
            id: r.osm_id,
            lat: num(r.lat),
            lon: num(r.lon),
            tags: {
              name: String(r.name ?? brand),
              brand: ((r.extratags ?? {}) as Record<string, string>).brand ?? brand,
              'addr:suburb': a.suburb ?? a.town ?? a.city ?? '',
              'addr:street': a.road ?? '',
              'addr:housenumber': a.house_number ?? '',
            },
          };
        });
      all.push(...parseStores({ elements }, { lat, lon }, section));
    }
    await sleep(1100); // Nominatim asks for no more than one request a second.
  }
  return dedupe(all.sort((a, b) => a.km - b.km));
}

/** The closest shops of a section (supermarkets, bottle shops or pharmacies) within about 25 km, nearest first. */
// Answers for this session, so opening the same screen again doesn't ask the map again.
const nearbyCache = new Map<string, NearbyStore[]>();

export async function nearbyStores(lat: number, lon: number, section: Section = 'pantry', chains?: StoreChain[]): Promise<NearbyStore[]> {
  const key = `${section}:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = nearbyCache.get(key);
  if (hit) return hit;
  const found = await nearbyStoresFresh(lat, lon, section, chains);
  if (found.length) nearbyCache.set(key, found);
  return found;
}

/**
 * The shops you've ticked, looked up two ways at once: the map's list of nearby shops, and a
 * search by each shop's name (which finds branches the map hasn't tagged with a brand).
 */
export async function findPickedShops(lat: number, lon: number, section: Section, chains: StoreChain[]): Promise<NearbyStore[]> {
  if (import.meta.env.VITE_FAKE_STORES === '1') return fakeNearby(section, lat, lon).filter((s) => chains.includes(s.chain));
  const [map, byName] = await Promise.allSettled([nearbyStores(lat, lon, section), nominatimStores(lat, lon, section, chains)]);
  if (map.status === 'rejected' && byName.status === 'rejected') throw map.reason;
  const all = [...(map.status === 'fulfilled' ? map.value : []), ...(byName.status === 'fulfilled' ? byName.value : [])];
  return dedupe(all.filter((s) => chains.includes(s.chain)).sort((a, b) => a.km - b.km));
}

async function nearbyStoresFresh(lat: number, lon: number, section: Section, chains?: StoreChain[]): Promise<NearbyStore[]> {
  // Test builds only (VITE_FAKE_STORES=1): canned shops so the finder can be clicked through off-phone.
  if (import.meta.env.VITE_FAKE_STORES === '1') return fakeNearby(section, lat, lon);
  // Ask all the map servers at once and take the first good answer. If they're slow or all
  // fail, the Nominatim backup starts too.
  const servers = Promise.any(OVERPASS.map((b) => overpassFrom(b, lat, lon, section)));
  let backupStarted = false;
  const backup = new Promise<NearbyStore[]>((resolve, reject) => {
    const start = () => {
      if (backupStarted) return;
      backupStarted = true;
      nominatimStores(lat, lon, section, chains).then(resolve, reject);
    };
    const t = setTimeout(start, 8000);
    servers.then(
      () => clearTimeout(t),
      () => {
        clearTimeout(t);
        start();
      },
    );
  });
  try {
    return await Promise.any([servers, backup]);
  } catch {
    throw new Error("Couldn't reach the map servers. Check you're online and try again, or type your store names instead.");
  }
}
