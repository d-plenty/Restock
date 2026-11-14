import { useEffect, useRef, useState } from 'react';
import type { NearbyStore } from '../lib/places';
import { chainName, shopColor, type StoreChain } from '../shops';
import { Icon } from './components';

// 0.10.7: the shops found near you, on a map. It's only loaded when you open it, from OpenFreeMap
// (free maps made from OpenStreetMap: no account, no key, no tracking), so OpenFreeMap sees which
// area the map shows, as any map does. The list under it stays the main way to pick: the map is
// there to see where things are.

export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

type MapLib = typeof import('maplibre-gl');
let lib: Promise<MapLib> | undefined;
const load = () => {
  lib ??= Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl.css')]).then(([m]) => (m as unknown as { default?: MapLib }).default ?? m);
  lib.catch(() => (lib = undefined));
  return lib;
};

export function StoreMap({
  centre,
  stores,
  picked,
  onPick,
}: {
  centre: { lat: number; lon: number };
  stores: NearbyStore[];
  /** Which ones are your Primary or 2nd now. */
  picked: (s: NearbyStore) => 'primary' | 'secondary' | undefined;
  onPick: (s: NearbyStore, slot: 'primary' | 'secondary') => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState<NearbyStore>();

  useEffect(() => {
    let map: import('maplibre-gl').Map | undefined;
    let gone = false;
    void load()
      .then((m) => {
        if (gone || !box.current) return;
        map = new m.Map({
          container: box.current,
          style: MAP_STYLE,
          center: [centre.lon, centre.lat],
          zoom: 11,
          attributionControl: { compact: true },
          cooperativeGestures: true,
        });
        map.addControl(new m.NavigationControl({ showCompass: false }), 'top-right');
        const bounds = new m.LngLatBounds([centre.lon, centre.lat], [centre.lon, centre.lat]);
        for (const s of stores) {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'map-pin';
          el.style.background = shopColor(s.chain as StoreChain);
          el.setAttribute('aria-label', `${s.name}, ${chainName(s.chain)}`);
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            setChosen(s);
          });
          new m.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map);
          bounds.extend([s.lon, s.lat]);
        }
        // clear of the zoom buttons in the top right
        if (stores.length) map.fitBounds(bounds, { padding: { top: 56, right: 64, bottom: 40, left: 40 }, maxZoom: 14, duration: 0 });
        map.on('error', (e) => {
          if (!gone && /fetch|network|failed/i.test(String(e.error?.message ?? ''))) setError("The map couldn't load. Check your internet, or pick from the list.");
        });
      })
      .catch(() => setError("The map couldn't load. Pick from the list instead."));
    return () => {
      gone = true;
      map?.remove();
    };
  }, [centre.lat, centre.lon, stores]);

  const slot = chosen ? picked(chosen) : undefined;
  return (
    <div className="store-map-wrap">
      <div ref={box} className="store-map" role="region" aria-label="Map of the shops near you" />
      {error && (
        <p className="small" role="status" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {chosen ? (
        <div className="row near-branch" role="status">
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="title" style={{ fontSize: 15 }}>
              {chosen.name}
            </span>
            <span className="small">
              {chainName(chosen.chain)}
              {chosen.address ? ` · ${chosen.address}` : ''}
            </span>
          </span>
          <span className="store-pick">
            <button className="chip" aria-pressed={slot === 'primary'} onClick={() => onPick(chosen, 'primary')}>
              Primary
            </button>
            <button className="chip" aria-pressed={slot === 'secondary'} onClick={() => onPick(chosen, 'secondary')}>
              2nd
            </button>
          </span>
        </div>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          <Icon name="pin" size={14} /> Tap a pin to pick that shop. Maps: OpenFreeMap, from OpenStreetMap.
        </p>
      )}
    </div>
  );
}
