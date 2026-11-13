// 0.9.14: Settings → About → Credits. The open data and the open-source code Restock is built with,
// with their licences. Keep it in step with package.json and the README's "Thanks".

interface Credit {
  name: string;
  what: string;
  licence: string;
  url: string;
}

const DATA: Credit[] = [
  { name: 'Open Food Facts', what: 'Product names, ingredients and nutrition from barcodes (with Open Beauty Facts and Open Products Facts)', licence: 'ODbL', url: 'https://world.openfoodfacts.org' },
  { name: 'OpenStreetMap contributors', what: 'Shop locations near you (Nominatim and Overpass)', licence: 'ODbL', url: 'https://www.openstreetmap.org/copyright' },
  { name: 'Food Standards Australia New Zealand, Product Safety Australia and the TGA', what: 'The official recall lists', licence: 'Public information', url: 'https://www.foodstandards.gov.au' },
  { name: 'hotprices-au', what: 'Past Coles and Woolworths prices, folded into restock-prices by its collector', licence: 'MIT', url: 'https://github.com/Javex/hotprices-au' },
];

const CODE: Credit[] = [
  { name: 'Capacitor', what: 'Runs Restock as an Android app', licence: 'MIT', url: 'https://capacitorjs.com' },
  { name: 'React', what: 'The screens', licence: 'MIT', url: 'https://react.dev' },
  { name: 'sql.js', what: 'The database in a browser', licence: 'MIT', url: 'https://github.com/sql-js/sql.js' },
  { name: 'zxing-cpp and zxing-wasm', what: 'Barcode and QR code scanning', licence: 'Apache-2.0 and MIT', url: 'https://github.com/zxing-cpp/zxing-cpp' },
  { name: 'Tesseract and tesseract.js', what: 'Reading receipts, with its English model', licence: 'Apache-2.0', url: 'https://github.com/naptha/tesseract.js' },
  { name: 'JsBarcode', what: 'Drawing loyalty card barcodes', licence: 'MIT', url: 'https://github.com/lindell/JsBarcode' },
  { name: 'noble ciphers, curves and hashes', what: 'Encryption for sync and backups', licence: 'MIT', url: 'https://paulmillr.com/noble/' },
  { name: 'fflate', what: 'Zipping and unzipping', licence: 'MIT', url: 'https://github.com/101arrowz/fflate' },
  { name: 'AndroidX and WorkManager', what: 'Background price checks and the Android parts', licence: 'Apache-2.0', url: 'https://developer.android.com/jetpack/androidx' },
];

function List({ items }: { items: Credit[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((c) => (
        <li key={c.name} className="small">
          <a href={c.url} target="_blank" rel="noreferrer">
            <strong>{c.name}</strong>
          </a>
          : {c.what}. <span className="num">{c.licence}</span>
        </li>
      ))}
    </ul>
  );
}

export function Credits() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 14px 14px' }}>
      <p className="small" style={{ margin: 0 }}>
        Restock is free and open source (GPL-3.0), and it stands on other people's generous work. Thank you to everyone below.
      </p>
      <span className="title" style={{ fontSize: 15 }}>
        Data
      </span>
      <List items={DATA} />
      <span className="title" style={{ fontSize: 15 }}>
        Code
      </span>
      <List items={CODE} />
      <p className="small" style={{ margin: 0 }}>
        Shop prices come from each shop's own website. Restock isn't connected with any shop. Made in Australia, for Australian shoppers.
      </p>
    </div>
  );
}
