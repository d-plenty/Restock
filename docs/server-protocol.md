# Restock server protocol (v2, Restock 0.9.2; v3, Restock 0.9.4)

The contract between the server (`server/`), the phones (Java, `ServerFolder.java` and friends) and the
web app (the Restock web build running in a browser, served by the server). Three people build these at
once: change this file only when you must, keep the change small, and list it under "Changes" at the end.

**v3 (0.9.4)**, where the server is the household's owner and can read what phones share, is the section
"v3" at the end (design and reasons: `docs/server-v3-design.md`). Everything above it is v2, which a server
keeps serving byte for byte while it's in `v2` mode.

The 0.9.1 RC patch (`restock-server-0.9.1.patch`, one shared access code, read-only viewer) was never
released. v2 replaces its auth; its file storage, sealing and tests are the starting point.

## Principles
- **End to end.** The server stores and hands back sealed files. It never has the household key, the
  server key or anything that opens them. A full copy of the server's data volume reveals nothing but
  file names, sizes, times, device names and the activity log.
- **Local first.** Phones never wait for the server. Everything works without it.
- **One household per server.**

## Keys
- `householdKey`, `keyv`: the phones' household key and its version (unchanged from 0.9.1).
- `serverKey = HMAC-SHA256(householdKey, "restock-server-files-v1")` (32 bytes). Every file stored on the
  server is sealed with the serverKey of the key version it names. The web never gets the householdKey.
- Sealed file format: the same `RSF1` format as folder sync (`SyncFolder.java`): `RSF1` + 12-byte nonce +
  AES-256-GCM(gzip(JSON)). The JSON names its `keyv`.

## Devices (phones)
- Each phone has its own **ECDSA P-256 key pair** for the server (`server_dev_priv` in sync meta, sealed by
  `SyncKeystore`). The server stores only the public key, so the server's files can't be used to pose as a
  phone.
- **Adding a phone**: a signed-in web user taps **Add a phone** → `POST /api/v2/invites` → `{ invite, expires }`
  (32 random bytes, base64url; works once, for 10 minutes). The page shows the QR code
  `restock-server:2?h=<home URL>&a=<away URL>&i=<invite>` (`a` optional; URL-encoded).
  The phone scans it and calls `POST /api/v2/devices` `{ invite, device, name, pub }` (`device` is the phone's
  sync device id, `pub` the SPKI public key, base64). One invite, one phone.
- **Signed requests** (every phone request after joining):
  `Authorization: Restock2 d=<device>, t=<unix ms>, n=<16 random bytes b64url>, s=<sig b64>` where
  sig = ECDSA-SHA256 (DER) over `METHOD\nPATH_AND_QUERY\nt\nn\nhex(sha256(body))`. Within 5 minutes of the
  server's clock; on `{"error":"clock"}` (401) with header `X-Restock-Time`, retry once with the offset.
  Each nonce works once (keep 10 minutes of nonces).
- `DELETE /api/v2/devices/<device>` (web user or the phone itself) removes a phone's access. The web's
  Phones page lists them with name, last seen and a Remove button.
- Home first, then away: phones try `h` then `a` (as in the RC patch). Plain http only to private, `.local`,
  `.lan` or Tailscale (100.64.0.0/10) addresses, using 0.9.1's `SyncDav` HTTP client rules.

## Web users
- One user. First start: `RESTOCK_USER` (default `admin`) and `RESTOCK_PASSWORD` (default `admin`) from the
  environment, used **only while no passphrase has been set**. Logging in with them gives a session that can
  do nothing but set the passphrase (`mustChange`).
- **Passphrase**: at least 20 characters or 4 words, checked in the page with a strength meter (no common
  passwords, not the user name, not `admin`). The browser derives
  `PBKDF2-HMAC-SHA256(NFKC(passphrase), salt, 600000, 64 bytes)`: bytes 0–31 `authKey` (sent to the server,
  which keeps only `scrypt(authKey)`), bytes 32–63 `vaultKey` (never leaves the browser).
  - `GET /api/v2/login/salt?user=` → `{ salt }` (a fake, stable salt for unknown users)
  - `POST /api/v2/login` `{ user, password }` (setup only) or `{ user, auth }` → sets the session cookie
    (`HttpOnly; SameSite=Strict; Path=/`, plus `Secure` on https), returns `{ mustChange, vault }`.
  - `POST /api/v2/passphrase` `{ salt, auth, vault }` (session) sets or changes it. Changing it re-locks the
    vault in the browser and sends the new `vault`.
  - Rate limits: 10 wrong logins per address → 15-minute lockout; sessions expire after 30 days unused,
    and **Sign out everywhere** on the Account page.
- **Vault**: `RSV2` + nonce + AES-256-GCM(vaultKey, JSON `{ webId, webPriv, keys: { "<keyv>": "<serverKey b64>" } }`),
  stored on the server (`GET`/`PUT /api/v2/vault`, session only). `webPriv` is the web's own ECDH P-256
  private key; its public key is registered with the server (`webPub`, in `GET /api/v2/web`).
- **Linking the household to the web (once)**: after the passphrase is set and the vault has no keys, the page
  shows **Link with a phone**: the browser makes a link request `POST /api/v2/link` → `{ id }` and shows
  `restock-link:2?u=<origin>&s=<id>&k=<web ECDH public key b64url>`. A joined phone scans it (Sync screen →
  Restock server → **Scan the web page's code**), asks "Let this browser see your household?", and posts
  `POST /api/v2/link/<id>` (signed) `{ pub: <phone ephemeral ECDH pub>, sealed }` where sealed =
  AES-256-GCM(HKDF-SHA256(ECDH, info "restock-link-v2"), JSON `{ keys: {keyv: serverKey}, household }`).
  The browser polls `GET /api/v2/link/<id>`, opens it, adds the keys to the vault and saves it.
  The QR carries the browser's public key, so the server can't swap in its own.
- **Sign in with a phone** (QR login, any time): the login page does `POST /api/v2/qrlogin` → `{ id }` with a
  fresh ECDH key and shows `restock-login:2?u=<origin>&s=<id>&k=<pub>`; a joined phone scans and approves;
  it posts like linking; the server then gives that browser a session; the browser opens the keys. A browser
  signed in this way keeps the keys for the session only (it can't open the vault without the passphrase).
- **After a rekey** (a phone removed): phones keep writing `webkeys/<webId>.bin` = the current serverKey and
  keyv sealed to each registered `webPub` (ECDH with a fresh phone key, same HKDF/AES as linking). The web
  adds it to its vault next time it's open. A removed web user (Sign out everywhere / new passphrase) gets a
  new webId.

## Files
`GET /api/v2/files` → `{ files: [{ name, size, modified, version, by }] }`; `GET/PUT/DELETE /api/v2/files/<name>`.
Phones: read everything, write their own names. Web session: read everything, write only
`restock-sync-web-<webId>.bin`. Allowed names (anything else is refused):
- `restock-sync-<device>.bin`: that device's sealed changes (the folder-sync file; the web's device is `web-<webId>`).
- `restock-sync-keys-<hid>.json`: the owner's rekey file (as folder sync).
- `archive/<device>/<yyyy-mm>.bin`: sealed `{ prices: [...], receipts: [...] }` that phone moved off itself
  (see Offload). Written once per month file, replaced when it grows.
- `photos/<sha256 hex>.bin`: a sealed receipt or product photo, named by the sha256 of the photo bytes.
- `webkeys/<webId>.bin`: as above.
Bodies: `.bin` must start with `RSF1` (or `RSE2` for ECDH-sealed webkeys), `.json` must be JSON; size caps
32 MB per file, 2 GB per data volume (setting). Writes are atomic.

## Offload (phones)
- With a server connected, the phone's **Keep price history for** setting is how much it keeps on the phone.
  Prices older than that, and receipt photos older than that, go to `archive/` and `photos/`.
- The phone deletes its own copy **only after** a `GET /api/v2/files` shows the archive/photo with the same
  size and `version` it uploaded. Nothing is deleted while the server is unreachable.
- Without a server, 0.9.1 behaviour is unchanged.

## Web app
The real Restock UI (the web build), served by the server at `/`, in "server mode": it keeps a local sql.js
database in the browser, fills it by reading and merging every `restock-sync-*.bin` and the `archive/`
files with the same merge rules as `SyncEngine.apply`, and writes its own edits as
`restock-sync-web-<webId>.bin`. Shop searches, price checks, shop sign-ins and anything that needs the
phone's hardware are hidden with a plain note ("Do this on a phone: shops don't let a web page check
prices"). Cards (loyalty and gift) show greyed out with the shop's name and "Kept on your phones for privacy"; their
numbers are never shown (the web build strips them on read).

## Endpoints at a glance
| Method and path | Who |
|---|---|
| `GET /api/v2/health` | anyone (`{ ok, app, version, api: 2 }`) |
| `GET /api/v2/login/salt`, `POST /api/v2/login`, `POST /api/v2/logout` | anyone / session |
| `POST /api/v2/passphrase`, `GET`/`PUT /api/v2/vault`, `GET /api/v2/web` | session |
| `POST /api/v2/invites`, `GET /api/v2/devices`, `DELETE /api/v2/devices/<id>` | session (delete: also the phone) |
| `POST /api/v2/devices` | invite holder |
| `POST /api/v2/link`, `GET /api/v2/link/<id>` | session |
| `POST /api/v2/qrlogin`, `GET /api/v2/qrlogin/<id>` | anyone (rate-limited, 2-minute expiry) |
| `POST /api/v2/link/<id>`, `POST /api/v2/qrlogin/<id>` | phone (signed) |
| `GET /api/v2/files`, `GET/PUT/DELETE /api/v2/files/<name>` | phone (signed) or session |
| `GET /api/v2/activity` | session |

## Changes
- **(web) Exact wire formats the web app uses** where the text above leaves them open. All bytes in JSON
  bodies and QR parameters are base64url without padding (readers also take plain base64).
  - Public keys (`pub`, `k`, `webPub`, `owner_pub`) are P-256 SPKI DER (Java's `getEncoded()`, 91 bytes).
  - Link / QR sign-in: `sealed` = 12-byte nonce + AES-256-GCM (no associated data) with key
    HKDF-SHA256(ikm = ECDH shared x-coordinate (32 bytes), no salt, info `restock-link-v2`, 32 bytes).
    Plaintext `{ keys: { "<keyv>": "<serverKey>" }, household: { name, owner_pub } }`. `GET /api/v2/link/<id>`
    and `GET /api/v2/qrlogin/<id>` answer `{ pending: true }` until the phone posted, then `{ pub, sealed }`.
  - `webkeys/<webId>.bin` = `RSE2` + the phone's one-off public key (SPKI, 91 bytes) + nonce + ciphertext,
    sealed as the link (same HKDF info, no associated data); plaintext `{ keys: { "<keyv>": "<serverKey>" } }`.
  - Vault: `RSV2` + nonce + AES-256-GCM(vaultKey, JSON), associated data `RSV2` (browser only).
    `GET /api/v2/vault` → `{ vault }` (null if none); `PUT /api/v2/vault` `{ vault, webId, webPub }`; the login
    answer's `vault` is the same base64url string. `POST /api/v2/passphrase` also carries `webId, webPub`
    (that registers the web's id and public key, so the server knows `restock-sync-web-<webId>.bin` is the
    session's own name). `GET /api/v2/web` → `{ user, webId, webPub, mustChange }`.
  - `POST /api/v2/logout` `{ everywhere: true }` ends every session (Account → Sign out everywhere). Before it,
    the browser gives itself a new webId and key pair (`PUT /api/v2/vault`).
  - `GET /api/v2/devices` → `{ devices: [{ device, name, added, seen }] }`; `GET /api/v2/activity` →
    `{ activity: [{ at, who, what, file, size }] }` (the web shows what's there; extra fields are fine).
  - The web's own file is a folder-sync file exactly as `SyncFolder.writeOwn` writes it (`format`
    `restock-sync`, `v` 1, `device` `web-<webId>`, `name`, `keyv`, `at`, `top`, `seen`, `entries`), sealed with
    the newest serverKey. It never carries `household` or `cards` entries, and no prices.
  - `archive/<device>/<yyyy-mm>.bin` plaintext: `{ format: "restock-archive", device, keyv, prices: [price rows,
    no id], receipts: [receipt rows], photos: { "<receipt photo path>": "<sha256 hex>" } }`. Any
    `restock-sync-*.bin` may carry the same top-level `photos` map. `photos/<sha256>.bin` plaintext:
    `{ type: "image/jpeg", data: "<base64>" }` (sha256 of the photo's bytes).
- **(phones) What the phones do where the text above leaves it open**, matching the web's formats above.
  - Signing: `n` = 16 random bytes base64url; `s` = the DER signature, standard base64 (Node's base64 reads
    both). `hex(sha256(body))` is lowercase; no body hashes the empty string. File names go in the path
    as they are, slashes included (`/api/v2/files/archive/<device>/2026-08.bin`), no percent-encoding;
    PATH_AND_QUERY is exactly the request target the phone sends, so a proxy in front mustn't rewrite the
    path. 401 refusals the phone tells apart by `error`: `clock` (with `X-Restock-Time`, retried once) and
    `removed` (taken off the server's list: "Scan a new code"); anything else shows the server's `message`.
  - `POST /api/v2/devices` `{ invite, device, name, pub }` (pub SPKI, base64url): any 2xx is joined; `invite`
    (not this server's), `used` and `expired` refusals are told apart. A good invite for a device id already
    listed replaces that device's key and name (a phone joining again after Stop), as the server does.
  - **Addition:** `PUT /api/v2/files/<name>` answers `{ name, size, version }` (as in the listing). A phone
    deletes an offloaded copy only after a later `GET /api/v2/files` lists that name with the same size and
    version; no version in the answer, nothing is deleted.
  - `GET /api/v2/web` signed by a phone: the phone reads `webs: [{ webId, webPub }]` (as the server answers).
  - **Addition:** phones seal keys (webkeys/) only to a webPub they can trust: one this phone approved by
    scanning that browser's link code, or the `webPub` (SPKI, base64url) inside that web's own sealed
    `restock-sync-web-<webId>.bin`, which only a browser that already has a serverKey can write. So the web
    writes its file right after linking (empty `entries` is fine) and always includes `webPub`. A webPub
    the server adds by itself gets nothing.
  - Link and QR sign-in from the phone: the phone refuses a code whose `u` host isn't its server's home or
    away host. Plaintext `{ keys, keyv, household: { name, owner_pub } }`; `keys` (base64url, as the vault)
    holds every serverKey that phone has known, older key versions too, so older archive and photo files
    stay readable. webkeys files carry `{ keys, keyv }`.
  - Archive months: a price's month is the first 7 characters of its `date`; a receipt photo's is the
    receipt's `scanned_at`. The file also has `month` and `v: 1`. A phone rewrites a month file when it adds
    to it, and when one of its receipts is deleted (the row and its `photos` entries go, and so does
    `photos/<sha256>.bin`). A phone that finds `photos/<sha256>.bin` already listed (another phone had the
    same photo) opens it, checks the sha256 and uses it. Photo files are RSF1 with `{ format:
    "restock-photo", v: 1, keyv, sha256, type: "image/jpeg", data }`.
  - What's offloaded is only what the household already shares: prices of products on the tabs this phone
    syncs, and photos of receipts only when the household shares receipts. The rest stays on the phone and
    is tidied as before. The phone's own `restock-sync-<device>.bin` carries prices changed in the last 60
    days and a top-level `photos` map of its offloaded photos.
  - **Addition (phone review):** on a server, a phone passes over any `restock-sync-*.bin` whose `device`
    isn't the one in its name, and leaves out `household`, `cards` and `prices` entries from a `web-…`
    device's file. Before deleting its own copy it also reads the file back and checks it's the bytes it
    sent (and that the PUT answer's `size` was their length). A month file is read before it's rewritten
    even when the listing doesn't show it. Offloaded photos aren't fetched back over the Wi-Fi.
    `photos/<sha256>.bin` is deleted only once the receipt has gone and no other device's sync file lists
    that sha256 in its `photos` map (a phone's map leaves out photos whose receipt has gone).
- **(server) What the server adds or pins down** (all additive; the web app's client above already works with it).
  - Port **8787** (the RC's). Errors are `{ error: "<code>", message: "<plain words>" }`; codes include `auth`,
    `clock`, `replay`, `removed` (a removed phone), `signed-out`, `mustChange`, `passphrase` (needs a passphrase
    session), `forbidden`, `name`, `sealed`, `too-big` (413), `full` (507), `invite`, `used`, `expired` (410),
    `locked` (429, `Retry-After`), `rate`, `setup`.
  - `GET /api/v2/login/salt` adds `setup: true` while no passphrase is set.
  - While the password is still the default `admin`, the first-start login only works from home: the socket
    address must be loopback, private, link-local or Tailscale (100.64.0.0/10), and so must any address in
    `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP` or `Forwarded`. Otherwise 403
    `setup-remote`. Headers only make it stricter. With their own `RESTOCK_PASSWORD`, from anywhere.
  - `POST /api/v2/passphrase`: `vault`, `webId` and `webPub` are optional (the server's setup page sends only
    `{ salt, auth }`; the web app then makes the vault at its first sign-in). A new passphrase can't reuse the
    current or a retired webId. Every other session is signed out; this one carries on.
  - The web key is registered by `PUT /api/v2/vault { vault, webId, webPub }` or `PUT /api/v2/web { webId, webPub }`
    (passphrase session). A new webId retires the old one, and retired webIds are refused. `GET /api/v2/web` is
    also open to phones (signed), for `webkeys/`: `{ webId, webPub, webs: [{ webId, webPub }] }`; sessions also
    get `user`, `mustChange` and `session: { kind, webId, approvedBy }`.
  - **Sign out everywhere** is `POST /api/v2/logout { everywhere: true }`: ends every session and every waiting
    link or sign-in code. It doesn't change the webId (the web app moves to a new one first, as above).
  - Sessions: `passphrase` (30 days unused); `phone` (signed in with a phone: writes as the household's webId,
    can't change the vault or web key or make link codes, ends after 12 hours unused or when the phone that let it
    in is removed); the first-start session (1 hour, nothing but the passphrase).
  - `POST /api/v2/invites` also returns `expiresIn`, `home`, `away` and `code` (the whole `restock-server:2?…` text).
    `home` is `RESTOCK_HOME_URL`, else the address the page was opened with; `away` is `RESTOCK_AWAY_URL`.
  - Link and sign-in polls answer `{ pending: true, status: "waiting", expires }`, then once
    `{ pending: false, status: "done", pub, sealed, device, deviceName }` (sign-in adds `mustChange`, `webId`).
    Link codes last 10 minutes and only the session that made one can read it. `POST /api/v2/qrlogin` sets an
    HttpOnly `restock_qr` cookie (Path `/api/v2/qrlogin`), and only the browser holding it can collect the
    session, so someone who photographs the code can't take it. It's refused (409 `setup`) before a passphrase is
    set, and limited to 10 per 10 minutes per address.
  - Phones: a `device` id can't start with `web-`. A known id joining again with a new invite replaces its key.
    `GET /api/v2/devices` → `{ devices: [{ device, name, added, lastSeen, seen }] }`. A phone may write its own
    sync file and archive, any `restock-sync-keys-*.json`, `photos/` and `webkeys/`. `webkeys/` bodies must be
    `RSE2`, other `.bin` `RSF1`; webIds are 8–60 of `A-Z a-z 0-9 _ -`.
  - Signed requests: `PATH_AND_QUERY` is the request target exactly as sent; `n` is 16–32 base64url characters;
    `s` may be base64 or base64url (DER; a 64-byte raw signature is also taken). Serve the server at the root
    of its host name. File `GET`s carry `ETag` and `X-Restock-Version` (304 on `If-None-Match`); names may use
    `/` or `%2F`.
  - `GET /api/v2/activity?limit=` → `{ activity: [{ at, what, file?, by?, who?, device?, size?, ip? }], devices,
    server: { version, started, files, bytes, maxBytes, maxFileBytes } }`, newest first; addresses are masked.
- **(security review) Tightened, all compatible with the phones** (the phones never use these endpoints).
  - `POST /api/v2/passphrase` once a passphrase is set: only a `passphrase` session (a phone sign-in gets 403
    `passphrase`), and it must carry `current`, the current passphrase's authKey (missing: 400 `current`;
    wrong: 403 `current`, counted towards the lockout). The answer sets a new session cookie (the setup one stops
    working). `GET /api/v2/vault` is for `passphrase` sessions only.
  - A session's `POST` must be `Content-Type: application/json` (else 415): over plain http browsers send no
    `Sec-Fetch-Site`, and a page on another port of the same computer counts as the same site.
  - The first-start login is home-only while `RESTOCK_PASSWORD` is any well-known one (`admin`, the compose file's
    `change-me-now`, ...). Proxy headers are believed only on connections from a home address. Lockouts and rate
    limits count an IPv6 /64 as one address.
  - Web: a `webkeys/` file is only a candidate (anyone can seal to a public webPub). A key version the browser
    already has is never replaced; a new one is taken once it opens a phone's sync file that carries a household
    change signed by the pinned owner key (before one is pinned: one exactly as the browser already has it). A
    browser signed in with a phone has no web key pair, so its own file carries the `webPub` already sealed in
    that file (from the passphrase browser), never the one `GET /api/v2/web` gave it.
  - **Replaces** the two lines above that say a known device id joining again replaces its key: `POST
    /api/v2/devices` for an id that's listed with a different public key is refused, 409 `device-taken` ("That
    phone is already on this server. Remove it on the Phones page first, then add it again."); the invite stays
    unused. The same key again is fine (as before). A phone that has lost its key is removed on the Phones page
    first (Stop already takes a phone off the list).
  - Trash: deleting `archive/…` or `photos/…`, or another writer replacing one with different bytes, moves the old
    copy to `trash/<when>/<name>` in the data volume (outside `files/`, never listed or served) for 30 days; it
    counts towards the volume cap. A phone may `DELETE` only `archive/<its device>/…` (as before). A `DELETE` of a
    `photos/…` file by a phone that wasn't the last to write it is answered 200 `{ deleted: null, kept: <name> }`
    and the file stays (that phone has let go of it; the phone that put it there deletes it). A missing file is
    still 404.
- **(0.9.3) Household settings and the phones' summaries.** Additive: an older phone or web build passes
  over both (an unknown table's entries and an unknown top-level field are skipped; checked against
  0.9.0–0.9.2 in tools/sync-test).
  - Entries of a new synced table, `household_settings` (`pk` = its `k`; `row` = `{ k, v }`, `v` JSON),
    in every `restock-sync-*.bin` (phones' and the web's), as in folder and Wi-Fi sync. One row per
    setting: `shopAroundMin`, `defaultThresholdPct`, `listCompare`, `productOrder`, `recalls.enabled`,
    `tab:keg` / `tab:pharmacy` (on), `shop:<chain>` `{ on }` and, for shops people added,
    `shop:custom-…` `{ on, shop: { id, name, website, section, search?, createdAt }, removed? }`. The later
    change wins per row (`stamp`, then `device`), like any synced record; any phone and the web may write
    them (no signature). Rows for a tab are only in the files of devices that sync that tab. The owner
    phone seeds missing rows from its own settings with `stamp` 1, so any real change wins. Branches and
    store numbers are never in them. Rules: `src/lib/sharedSettings.ts` (web) and `SharedSettings.java`.
  - A phone's own `restock-sync-<device>.bin` **on a server** (not a folder's or WebDAV's) has a top-level
    `summary`: `{ v: 1, version, checks: { everyHours, weekday?, background, lastAt?, lastItems? },
    notifications: { catalogueDay, catalogueWeekday, daily, dailyTime?, greatDeals, monthly, stockUp,
    stockUpTips }, accounts: { woolworths, coles } (signed in, yes/no), cards (a count), backups: { on,
    everyDays, keep, lastAt?, photos }, historyWeeks, tabs, away ("none" | "folder" | "webdav" |
    "nextcloud" | "server"), homeAssistant: { on, entity? }, look: { theme, text ("Normal" … "Largest") },
    receipts, sharedPrices, updates: { on, everyDays (1 or 7) } }`. Built from an allow-list
    (`PhoneSummary.java`) and checked again by the web (`src/lib/phoneSummary.ts`); never an address,
    sign-in, password, token, card number, store number, area or folder. The web never writes one.
  - Phones list `GET /api/v2/files` every 60 seconds while Restock is open, and run a round only when a
    file's `version` changed (or their own file needs writing). Unchanged otherwise.
  - The shopping list's rows, in the same `household_settings` table (they aren't settings: applying the
    settings passes over them): `alias:<words>` → `"<item id>"` ("Always use this for 'milk'"; `<words>` as
    `matchKey` in `src/lib/haMatch.ts` leaves them), `keep:<list line id>` → `true` ("Keep it as just
    'milk'"), and `ha:phone` → `"<device id>"` (the one phone in the household that syncs the shopping list
    with Home Assistant; never a `web-` id). Checked strictly (`checkListRow` in `src/lib/sharedSettings.ts`):
    a key or value of any other shape, or a sample (`demo-`) item or line, is ignored. Any phone and the web
    may write them; the later change wins per row. A phone with Home Assistant already on and no row yet
    writes `ha:phone` with `stamp` 1 (like the seed), so a phone named elsewhere still wins. A phone that
    leaves keeps its `alias:` and `keep:` rows.
  - List lines that a phone made from Home Assistant's list have an `id` starting `ha-` (still just an id:
    older phones and both sync engines treat it as one). A line like that, not linked to an item or a shop's
    product and not ticked, shows "Pick my …" on every phone and the web unless a `keep:` row says not to.
  - **The web reads a file's author from its name**, as phones on a server always have: in
    `restock-sync-<device>.bin` (and a browser's `restock-sync-web-<webId>.bin`) the top-level `device` must
    be `<device>`, or the whole file is passed over (noted as seen, nothing taken in). A browser's file never
    changes `household`, `cards` or `prices` entries, on the web as on a phone. Unchanged for writers: every
    device already writes its own name with its own id inside.

## v3 (Restock 0.9.4): the server is the household's owner

The design, its decisions and the work packages are in `docs/server-v3-design.md`; this section pins the
bytes. The code is `src/server-mode/crypto.ts` (marked "0.9.4, protocol v3"), `src/server-mode/engine.ts`
(`role: 'server'`) and `src/lib/haSync.ts` (`haLineId`), bundled for the server as
`restock-core.mjs` (`npm run build:server-core`, `src/server-core/index.ts`). **Test vectors:**
`tools/sync-test/vectors-v3.json`, made with Node's own crypto and checked by `src/server-core/core.test.ts`;
the server's and the phones' (Java) tests read the same file.

### Conventions
- Bytes in JSON, QR codes and headers are base64url without padding (readers also take plain base64).
- Public keys are P-256 SPKI DER (91 bytes, Java's `getEncoded()`). Private keys the server receives or
  hands out (`owner_priv`) are PKCS#8 DER as Java writes them; the core reads Java's and Node's encodings
  (`privOfPkcs8`) and writes the short form (`pkcs8Of`), which both read.
- **ECDH** is P-256; its secret is the shared point's x-coordinate (32 bytes), as Java's `KeyAgreement`.
- **HKDF** is HKDF-SHA256 with 32 bytes out. "No salt" is RFC 5869's default (32 zero bytes). A salt that
  travels as base64url (`n`, `c`, an invite, a token, a sign-in id) is its decoded bytes.
- **Sealed** = 12-byte random nonce + AES-256-GCM (16-byte tag) over UTF-8 JSON, with the associated data
  named below (as UTF-8; `+ device` appends the device id).
- Invites, handover tokens, challenges and sign-in ids are 32 random bytes; `n` is 16.
- ECDSA is SHA256withECDSA, DER signatures (as v2 and `SyncHousehold.java`).

### Keys and records
- Server keys (`keys.json`): `kex` (ECDH P-256, its SPKI is `k=` in every v3 code), the owner key
  (PKCS#8 + SPKI), `keyv`, household keys `{ "<keyv>": key }` for the versions it has, and serverKeys
  `{ "<keyv>": serverKey }` for **every** version (a phone keeps older versions as serverKeys only:
  `server_filekeys`). `serverKey = HMAC-SHA256(householdKey, "restock-server-files-v1")`, as v2.
- The household record's owner-only rows are signed by the owner key, as 0.9.0 (`restock-hh1|pk|v=…|stamp`).
  The server writes them through `WebSyncEngine.writeHousehold(k, v)`: the change goes through the
  database's triggers (stamped and noted as `srv-<sid>`), then its note gets the signature, as a phone's
  collect signs. The server keeps `sync_meta owner_pin` = its own `owner_pub`.
- **`server`** (new owner-only row, in `ownerOnly` on both sides): `{ "v": 3, "sid", "home", "away" (or
  null), "kex" (server kex SPKI), "keepMonths" (0.9.4: 3, 6, 9, 12 or null; 0.9.5: a whole number 1–120 or null) }` (`parseServerRow`). Write `owner =
  srv-<sid>` before `server`, so a 0.9.3 phone (no `server` in its `ownerOnly`) takes `server` in
  through `legacyAllowed` as the owner's.
- `member:<device>` = `{ "name": <label>, "pub": <the phone's my_pub> }`, signed by the server.
- The recovery copy (`recovery` row) is 0.9.0's: base64url(sealed, no associated data) with key
  `SHA-256("restock-recovery" ‖ r)`, `r` 20 random bytes shown as `formatRecovery(r)` (base32 in fours),
  JSON `{ secrets: { device: secret }, owner_priv, owner_pubkey, key, keyv (a string), oldkey?, oldkey_until? }`
  (`sealRecovery`/`openRecovery`). Each phone's `secret` is 32 random bytes the server makes at join.

### Joining (`POST /api/v3/join`, `POST /api/v3/upgrade`)
- Add a phone code: `restock-server:3?h=<home>&a=<away>&i=<invite>&k=<server kex SPKI>` (URL-encoded).
- Invite join body: `{ invite, device, name, pub, kex, myPub, n }` (`pub`: the phone's request-signing
  key, as v2; `kex`: its ECDH key; `myPub`: its household signing key).
- Member join body (no invite): `{ member: true, device, pub, kex, n, sig }`, `sig` = ECDSA by the phone's
  household signing key (`my_priv`) over `memberJoinText`:
  `"restock-member-v3\n" + device + "\n" + pub + "\n" + kex + "\n" + n` (the strings as sent). The server
  checks it with `member:<device>.pub`.
- Upgrade body (signed with the phone's v2 key, so `device` is the signer): `{ kex, myPub, n, ha? }`.
- Answer (all three): `{ sealed }`, sealed with `joinKey` = HKDF(ECDH(server kex, phone kex), salt `n`,
  info `restock-join-v3`), associated data `"RSJ3" + device`, JSON:
  `{ format: "restock-join", v: 3, device, label, seed, household: { name, hid, sid, owner_pub }, keyv,
  keys: { "<keyv>": householdKey } (every version the server has, at least the current one), serverKeys:
  { "<keyv>": serverKey } (every version), secret, server: { home, away, keepMonths } }`.
- `ha` on upgrade: sealed with HKDF(ECDH(server kex, phone kex), salt `n`, info `restock-ha-v3`),
  associated data `"RSA3" + device`, JSON `{ address, entity, enabled, token, state }` (`state`: its
  `HA_STATE`).

### After a rekey: `keys/<device>.bin` (RSE3)
`"RSE3"` + sealed with HKDF(ECDH(server kex, phone kex), no salt, info `restock-keys-v3`), associated data
`"RSE3" + device`, JSON `{ keyv, keys: { "<keyv>": householdKey } }` (at least the new one). Written by
the server only, readable by that device only. A phone takes only a higher `keyv` than it has.

### Handover (`POST /api/v3/handover/<token>`, RSH3)
- Code on the web: `restock-handover:3?u=<origin>&t=<token>&k=<server kex SPKI>`.
- Body (signed with the owner phone's v2 key): `{ epub, sealed }`; `epub` a one-off ECDH key; sealed with
  HKDF(ECDH(e, server kex), salt token, info `restock-handover-v3`), associated data `"RSH3"`, JSON
  `{ format: "restock-handover", v: 3, key (current household key), keyv, serverKeys: { "<keyv>":
  serverKey } (its server_filekeys and the current one), oldkey?, oldkey_until?, owner_priv (PKCS#8),
  owner_pubkey (SPKI), owner_secrets: { device: secret } (the other phones'), secret (its own), recovery?
  (base32), recovery_saved?, hid, name, ha? }`.

### Browsers (`RestockWeb3`)
- `loginKey = HKDF(authKey, no salt, "restock-login-v3")` (authKey is v2's PBKDF2 bytes 0–31).
- `GET /api/v3/login/challenge?user=` → `{ salt, c, kex }`. `POST /api/v3/login`
  `{ user, c, epub, proof }`, `proof = HMAC-SHA256(loginKey, "restock-login-v3\n" + c + "\n" + epub)`
  (`c` and `epub` as the base64url strings sent).
- `sessionKey = HKDF(ECDH(server kex, epub) ‖ loginKey, salt c, "restock-session-v3")` (the 32-byte
  secret, then the 32-byte loginKey). Answer `{ session, expires, sealed }`, `sealed` = base64url of RSF1
  with the sessionKey (`"RSF1"` + nonce + AES-GCM(gzip(JSON)), associated data `"RSF1"`, as v2's files) of
  `{ keys: { "<keyv>": serverKey } (every version), keyv, webId, household: { name, owner_pub } }`.
- Sign in with a phone: `POST /api/v3/qrlogin { epub }` → `{ id, kex, expires }`; the code is
  `restock-login:3?u=<origin>&s=<id>&k=<epub>`; `sessionKey = HKDF(ECDH(server kex, epub), salt id,
  "restock-session-v3")`.
- Every later request: `Authorization: RestockWeb3 s=<session>, t=<unix ms>, n=<16 random bytes>,
  m=<mac>`, `mac = HMAC-SHA256(sessionKey, METHOD\nPATH_AND_QUERY\nt\nn\nhex(sha256(body)))`, the same
  text a phone signs (`requestText`; body the bytes sent, sealed ones included; no body hashes the empty
  string). Clock window and nonces as v2's phone requests.
- Answers with household data, and request bodies with secrets, are raw RSF1 bytes sealed with the
  sessionKey, `Content-Type: application/x-restock-sealed`.

### Files and the merge
- Names: `allowedNameV3`: v2's less `restock-sync-keys-*.json` and `webkeys/`, plus `keys/<device>.bin`.
  `restock-sync-srv-<sid>.bin` (`serverFileName`) is the server's own, written by the server only.
- A phone's own file on a v3 server is v2's plus top-level `shares: { tabs: ["pantry" | "keg" |
  "pharmacy"], receipts: bool, cards: bool }` (`pantry` is the groceries: pantry and shopping list).
- The server's merge (`takeFile`, role `server`) takes from each phone only what it shares: a record of a
  tab, receipts or cards it doesn't share is passed over, and so is a `moved` delete of one; a plain
  delete of one is taken only when that phone **made** the record (its `origin` on the server, below; not
  merely the last to change it): "Also take what this phone shared off the server" (the phone sends deletes
  for its own records of that tab, the receipts' and the cards' too, even though it no longer shares
  them). A record whose maker isn't known stays. A file without `shares` (0.9.3 phones, browsers) is
  taken as it is. What a phone last declared is in `sync_meta phone_shares:<device>` (`sharesOf`);
  `lastDropped` counts what was passed over, for the log.
- **Who made a record** (0.9.4 final fixes): `sync_log.origin` (schema.ts `SYNC_094`), a device id or null
  (not known). The triggers set it to this device when a record is made (or made again, the moments
  `created` is set; a receipt saved again keeps it) and keep it through edits and deletes. Entries carry it
  as an optional `origin` in every sync file and Wi-Fi message (older readers pass it over). Taken in
  (`SyncEngine.originOf`, engine.ts `originOf`): a record that's here and live keeps its own unless the
  change made it again (a newer `created`); a new one, or one made again, takes the entry's `origin`, else
  the entry's `device` when that change was the one that made it (`stamp = created`); it's never filled in
  later. The server also doesn't believe a file whose phone claims to have made a record someone else
  changed last. Records from before 0.9.4: known only where `stamp = created` (their device made them and
  nobody changed them since); the rest stay unknown, so they're never taken back.
- **Deletes and tabs** (0.9.4 final fixes, phones and the engine alike): a plain delete of a record whose
  copy here is on a tab this device doesn't sync is passed over, like that tab's changes (so what a phone
  takes back never reaches a phone that doesn't share the tab, and its own copy stays). A `moved` delete
  (the record's own stamp) wins only when it's newer than the copy here, never by "a delete beats edits",
  so turning a tab off on one phone (whose file other phones read too) never deletes the others' copies of
  records it changed last.
- The server's own file is a sync file like a phone's: everything but `cards`, prices changed in the last
  60 days, the household's rows with their signatures, `seen`; `name` is the house's name.
- **Auto delete** (0.9.4: Keep data for): `keepCutoff(keepMonths, now)` = ISO time of `now − keepMonths × 2,629,800,000 ms`
  (a year's 365.25 days over 12; null for Until I delete). Phones use the same arithmetic with
  `keepMonths` from the signed `server` row. Incoming prices dated before it are passed over unless
  nothing newer for that product is on the server or in the same file (the latest stays, as
  `pruneHistory`); receipts scanned before it unless pinned; the same for archives. `prune(cutoff)` drops
  them quietly (no deletes go out) and returns the receipts that went, for their photos.
- `compact()`: deletes older than 90 days that every `member:` phone has seen (`seen` in their files).

### Home Assistant line ids
A line made from Home Assistant's item `uid` on the list `entity` has the id
`haLineId(entity, uid)` = `"ha-"` + the first 24 hex characters of
`sha256("restock-ha-v1\n" + entity + "\n" + uid)` (UTF-8). A store adds it with `INSERT OR IGNORE` and
returns that id whether it added it or it was there (`Store.addLine(line, uid)`); `syncRound` then pairs
the item with the line already there. 0.9.3's random `ha-` ids stay as they are.

### What the server (P2) answers, where the text above leaves it open
All additive to the shapes the web (P5) codes against; extra fields can be passed over.
- Sessions: each v3 browser session has its **own** `webId` (its file is `restock-sync-web-<webId>.bin`). The
  login, setup and `GET /api/v3/session` gift is `{ keys, keyv, webId, household: { name, owner_pub }, mode }`
  (`keys` `{}` and `household` null outside mode `v3`); `session` adds `user, kind, expires`. Every 2xx JSON answer to
  a RestockWeb3 request is sealed; errors stay plain JSON. `POST /api/v3/setup` also takes the setup page's v2
  passphrase cookie (then answers plain `{ ok, mode, house: { name } }`), and `{ name, afresh: true }` in mode
  `released` starts the server afresh (old files to the trash).
- `POST /api/v3/qrlogin/<id>` (phone): body `{}` or `{ k }` (the code's `k`; if sent it must be that sign-in's
  epub). `GET` answers `{ pending: true, status, expires }`, then once `{ pending: false, status: "done", session,
  expires, sealed }`; the sealed gift adds `device, deviceName`.
- `POST /api/v3/join` **bring** (a phone household onto a new, empty server, design section 7): the invite body
  plus `bring: { epub, sealed }`, `sealed` = `sealHandover(handoverKey(e, server kex, salt = the invite's decoded
  bytes), <the RSH3 payload>)`. Taken only while no phone has joined the server (else 409 `not-empty`); the answer
  is the usual RSJ3 gift with the brought household's keys (`seed: false`, `household.name` = the server's house name).
- `POST /api/v3/upgrade` answers `{ sealed, ha?: true }` (`ha` when the server took the phone's Home Assistant: only
  from the phone `household_settings ha:phone` names). A phone with a `removed:<device>` row gets 401 `removed`; one
  with no `member:<device>` row 403 `member` (being on the server isn't being in the household).
- `POST /api/v3/setup` and `POST /api/v3/handover` answer 409 `signin` until the server has the passphrase's
  `loginKey` (a v2 session from before the update): sign in again (v2) first.
- Home Assistant `PUT`/`test` with an address on another origin than the saved one need the token again (400 `token`
  / `ok: false`).
- `GET /api/v3/phones` rows add `api` (2: not upgraded yet). `POST /api/v3/phones` adds `expiresIn, label, home,
  away`. `DELETE /api/v3/phones/<d>` (passphrase session) → `{ removed, keyv }` (the new key version: browsers ask
  `GET /api/v3/session` again). `PATCH` → `{ device, label }`.
- `GET /api/v3/browsers` rows add `expires`, `device?` (the phone that let a phone sign-in in), `ip?` (masked).
- **The passphrase again** (0.9.4 final fixes) for the dangerous admin actions: the body carries `confirm: { c,
  proof }`, `c` a fresh challenge from `GET /api/v3/login/challenge` (used once), `proof` = HMAC-SHA256(loginKey,
  `"restock-login-v3\n" + c + "\n" + <this session's id>`) (`loginProof(loginKey, c, sid)`, as a passphrase change
  proves the current one; session.ts `confirmPassphrase`). Without it: 403 `confirm`; a wrong one 403 `current`
  (counted towards the sign-in lockout). Needed by: `POST /api/v3/recovery { confirm }` (the key), `POST
  /api/v3/backup`, `POST /api/v3/prune`, `PUT /api/v3/settings` when `keepMonths` gets shorter (or goes from Until
  I delete to a window: data is deleted), and `DELETE /api/v3/phones/<d>` (its body `{ confirm }`).
- `GET /api/v3/settings` → `{ name, keepMonths }`; `PUT` takes either (passphrase session) and answers the same;
  changing `keepMonths` re-signs the `server` row and prunes at once. `POST /api/v3/prune { before, confirm }` →
  `{ cutoff, prices, receipts, photos, archives, logs }` (counts).
- `GET /api/v3/recovery` → `{ saved }`; `POST /api/v3/recovery { confirm }` → `{ recovery, saved }`; `POST
  /api/v3/recovery { saved: true }` notes it was saved.
- **Receipt photos** (0.9.4 final fixes): a `PUT` of `photos/<sha256>.bin` must open with one of the household's
  serverKeys as `{ format: "restock-photo", sha256, data }` with `sha256` = the name's and = SHA-256 of `data`'s
  bytes, or it's refused (400 `photo`), new or replacing. The path → photo map a phone's file or archive gives
  (`photos`) is noted per path for that phone (`srv_photos.device`): another phone's file can't point a path at
  another photo, and a photo that isn't on the server isn't noted.
- **Connections** (0.9.4 final fixes): a request's headers must arrive within 20 seconds and all of it within
  10 minutes; a kept-alive connection with no request goes after 10 seconds, and one where nothing moves either
  way after 2 minutes. No endpoint holds an answer back (sign-in and link codes are polled, each poll answered at
  once), so only a client that stopped sending is cut off.
- `POST /api/v3/backup { passphrase, confirm }` refuses a backup passphrase that fails the passphrase rules (400 `weak`). The file:
  `RSB3`, 2-byte length, header JSON `{ v: 1, kdf: "scrypt", N, r, p, salt }`, 12-byte nonce, AES-256-GCM(gzip(tar))
  with the 16-byte tag at the end; associated data = everything before the nonce. `scripts/restore.mjs` reads it.
- Activity and log rows add `who` ("Web page", "The server", the phone's label, "A removed phone").
- `GET /api/v3/history` rows add `member_only, source`. `GET /api/v3/stats?months=` → `{ months: [{ month
  ("yyyy-mm"), receipts: { <tab>: total }, receiptCount, productsTracked, specialsSeen }] }`. `GET
  /api/v3/specials` → `{ specials: [latest special price per product, 14 days, with product name/chain/image],
  lists, catalogues }` (`lists`/`catalogues` as in the server's own file, below).
- Home Assistant: `GET` adds `phoneName`, `offOn`, `blocked` (why the server isn't running it, in words, or null);
  `PUT` also takes `offOn: "<device>"` ("It's off on <phone>", for a 0.9.3 phone still named in `ha:phone`), and
  `enabled: false` deletes the `ha:phone` row if it names the server. `test` adds `version`; `sync` adds `came,
  went, held` when `ok`.
- `household_settings` `branch:<chain>` (`chain` `[a-z0-9][a-z0-9_-]{0,63}`) = `{ "name" (1–80), "storeNo"?
  ([A-Za-z0-9 _-]{1,16}) }` and nothing else; anything else under `branch:` is passed over by the server.
- Shared specials: a phone file's top-level `specials` (`lists` ≤ 60, ≤ 1000 items each, ≤ 512 KB a list) and
  `catalogues` (http(s) `url` ≤ 500, `note` ≤ 300) are kept per chain, newest `at` wins, only for chains on tabs
  that file's `shares` includes; items keep only `storeProductId, name, price, wasPrice, promo, imageUrl
  (http(s)), isSpecial`. The server's own file carries `specials: { at, lists }` (lists of the last 14 days) and
  `catalogues`.
- The household's `tabs` and `receipts` after a handover or a bring stay as the household had them until every
  member that isn't removed is on v3; then the server signs `tabs = "pantry,keg,pharmacy"` and `receipts = "1"`
  (logged `household-widened`). A fresh house starts with both all on. Phones keep deciding by their own shares.
- Home Assistant: when the server takes it over (turned on from the web, "It's off on <phone>", a handover or an
  upgrade that brings it, while it's on), it writes `household_settings` `ha:phone = "srv-<sid>"` as its own change
  (noted as `srv-<sid>`, so it's in the server's file, newer than the phone's): the phone that ran it deletes its
  token and stops. Turned off on the web, the server deletes the row if it names itself. While `ha:phone` names a
  phone still on 0.9.3 (`api: 2`) without "It's off on <phone>", the server neither runs it nor writes the row.
- Errors v3 adds: `mode` (409, with `mode`), `released` (409), `update` (403, `api: 3`; also a 0.9.4 phone that
  hasn't upgraded yet on a v3 path other than upgrade), `v3` (409: a v2 endpoint the server no longer serves),
  `done`/`handover` (409), `member` (401), `not-empty` (409), `challenge` (401: the challenge was used or expired),
  `current` (403), `weak` (400), `core` (503: no Restock core in this copy), `node` (503).

### What the phones (P3) do, where the text above leaves it open
All within the shapes above; the server (P2) already answers them.
- **Codes.** `restock-server:3?h=&a=&i=&k=` (an Add a phone code without a P-256 `k` is turned down as damaged),
  `restock-handover:3?u=&t=&k=` (the phone checks `u`'s host is its server's, as for sign-in codes) and
  `restock-login:3?u=&s=&k=`. A 0.9.4 phone still reads `restock-server:2` and the v2 web codes.
- **Before joining** the phone asks `GET /api/v3/health` (unsigned). It reads `empty` (a boolean) only if the
  server sends one; otherwise an owner phone in a phone household is offered Bring, and a 409 `not-empty` (the
  invite isn't used) offers leaving its household and joining instead.
- **Joining fresh** (a phone in no household, or one that just left its own): it shares `tabs = "pantry"`,
  `share_receipts = "0"`, `share_cards = "0"`, Wi-Fi sync off (`sync_meta wifi_sync = "0"`), label "Home" for the
  server (`server_label`). Its own records go up "giving way": their `sync_log` stamps are set to -1 (below any
  other phone's), so wherever the house already has a record the house's copy wins, and a record only it has
  still goes up. The first phone of a new house (`seed: true`) keeps its stamps and seeds `household_settings`
  (`sync_meta seed_settings = "1"`), as the 0.9.3 owner did.
- **Upgrade** (after `403 update`): the answer is opened with the server's kex key pinned from a code (the owner
  phone pins it from the handover code). A phone that never scanned a v3 code takes it from the answer's `kex`,
  else health's `kex`, else `GET /api/v3/login/challenge`'s `kex` (public, in every code), and keeps it only
  because the opened gift holds this household's own key and its `owner_pub` equals the phone's pinned owner key.
  It then shares what it shared: its tabs and cards as they were, receipts as `receipts_eff` was.
- **`POST /api/v3/qrlogin/<id>`** (phone): `{ approve: true, k }`, `k` the code's browser key.
- **"Also take what this phone shared off the server"** (design 14): `sync_meta server_takeback` =
  `{ "keg" | "pharmacy" | "receipts" | "cards": <ms when ticked> }`. While a kind is in it, the phone's own file
  carries, instead of collect's `moved` deletes, a plain delete for each record of that kind this phone made
  (`sync_log.origin` = its id; a tab's categories, products, items, list lines, receipts and prices), stamped
  `max(ticked, its stamp + 1)`; records other phones made, or whose maker isn't known, stay. They're found a
  table at a time (joined with what their tab comes from), not a query a record. The phone keeps its own copy:
  it never takes in a delete by itself of a record it's taking back. Turning the kind on again clears it.
- **Leaving with take-back**: `syncStopServer({ bringBack, takeBack })`. The Leave sheet offers a box for each
  personal kind the phone shares (Keg, Health, receipts, loyalty cards; never groceries; gift cards are never shared), all unticked. Ticked
  ones are turned off and taken back as above, then one round puts the phone's file with the deletes on the
  server, then it leaves; if that round can't reach the server it doesn't leave (the error starts "Couldn't take
  those things off the server"), and the sheet offers leaving without taking them back.
- **Shared specials** (design 15) in the phone's file on any Restock server: `specials: { at, lists: [{ chain,
  at, items: [{ storeProductId, name, price, wasPrice, promo, imageUrl, isSpecial }] }] }` from what its Specials
  page already fetched (kv `specials`; at most 120 items a chain), and `catalogues: { "<chain>": { url, note? } }`
  for the shops it follows, from what its Catalogues page found (https only). Nothing is fetched for them.
- **`household_settings branch:<chain>`** (the web's default branch): a phone uses it only where it hasn't picked
  its own: `StoreChoice.primary` empty, or still the default it took (`householdBranch`); Coles' `branchStoreNo`
  likewise (`householdStoreNo`). It's applied only for the tabs the phone syncs, and never seeded.
- **In a house** the phone never writes or reads a keys file, `webkeys/` or a vault link; folder (and WebDAV)
  sync is turned off (D13); Wi-Fi sync stays, off by default for a phone that joined fresh. A `401 removed` makes
  the phone forget the household and keep everything (`notice = "server-removed"`); Leave is `DELETE
  /api/v3/devices/<me>` (best effort, after bringing offloaded receipt photos back if it can), then the same.

### v3, 0.9.5: Let the web page search the shops

The one time the server contacts a shop (Declan, 10 Nov 2026: option B). A server setting, **off by default**
(and off on servers from before: a `state.json` without it is off), stored in `state.json` `settings.webSearch`
(the server's own, not a household row: phones never see it). Only the admin turns it on or off.

- `GET /api/v3/settings` adds `webSearch: boolean`. `PUT /api/v3/settings { webSearch: true | false }` (a
  passphrase session, as every settings change; anything but a boolean is 400 `webSearch`). Logged
  `web-search-on` / `web-search-off`. Turning it off also forgets every search kept for Track.
- `POST /api/v3/search` (any signed-in browser, RestockWeb3; sealed answer)
  `{ q, section?: "pantry" | "keg" | "pharmacy" (default "pantry"), chain?: "<one of the household's shops on that
  tab>", barcode?: "<8–14 digits>" }` →
  `{ search: "<id>", at, expires, text: "<q as searched: normaliseQuery>", section, shops: [answer…] }`, one
  answer per shop, in the order the phone lists them:
  - `{ chain, name, status: "ok", items: [product…], top: ["<storeProductId>"…], message? }`: `items` best first
    (searchHelp `scoreAll`, counting where the shop put it, as Add.tsx), at most 40; `top` the ones the phone
    would recommend (`topPicks`); `message` when a web shop's page had nothing the server could read.
  - `{ chain, name, status: "blocked", blocked: true, message: "<Shop> blocked the search from your server.
    Search it on a phone instead." }`: the shop turned the direct request away (where the phone would use its
    hidden browser).
  - `{ chain, name, status: "error", message }`: too slow (10 s), too big (3 MB), sent elsewhere, unreachable.
  - `{ chain, name, status: "skipped", message }`: a shop people added (never asked from the server), or a
    built-in web shop with no known search page.
  - A product is the phone's `StoreProduct`: `{ chain, storeProductId, name, brand?, size?, barcode?, imageUrl?
    (https only), price?, wasPrice? (the usual price, only above price), isSpecial, halfPrice? (exactly half),
    memberOnly, promo?, unitPriceText? (the shop's), unitText? (the phone's unitTextOf), inStock?, itemId?,
    itemName? }`; `itemId`/`itemName` when one of the household's pantry items already has that product.
  - The shops: the household's shops on that tab (server `kv settings` `enabledChains`, `sections`; one per
    website, `searchChainsIn`), Coles at the `branch:coles` row's `storeNo` (falling back to its online shop, as
    the phone). With a barcode, Woolworths and Coles are also searched for the barcode itself (exact first).
  - Errors (plain JSON): 403 `web-search-off` "Turn on Let the web page search the shops in Settings." (checked
    first, before anything is read or counted); 401 `auth`; 403 `forbidden` for a phone; 400 `q` (empty, or over
    100 characters), `barcode`, `section`, `chain` ("That isn't one of your shops."), `shops` (the tab is off or
    has no shops); 429 `rate` (10 searches a minute per browser session) or `rate-server` (60 an hour for the
    whole server), with `Retry-After`. One search runs at a time; the others wait their turn.
- `POST /api/v3/search/add` (the same browser that searched, within 15 minutes; sealed answer)
  `{ search: "<id>", picks: [{ chain, storeProductId }…] (1–6, from that search), target?: "pantry" | "list" |
  "both" (default "pantry"), list?: "general" (the line on General instead of the tab's list: with `target "list"`
  only, no category), name?, categoryId?, qty? (1–99, default 1) }` →
  `{ item: { id, name, section } | null, products: ["<product id>"…], line: { id, list } | null }`. As the phone's Add
  saves: for `pantry`/`both` each pick's product (an existing one with the same chain and shop id is reused) with
  today's price as the shop gave it (`source "auto"`; the browser never sends a price), then a pantry item (first
  pick = My pick, the others the same thing at other shops; `name` or `genericName`; alert "good"); for
  `list`/`both` a list line (with the item, or on its own with the cheapest pick's chain, price and `product`
  details). The search's tab is the item's and line's. Written by the server (its sync triggers: device
  `srv-<sid>`), so they go out in the server's file to every phone (0.9.4 phones take them like any of the
  server's rows; no new kinds); each record's `sync_log.origin` is the browser's `web-<id>`. Errors: 403
  `web-search-off`; 410 `search-gone` (unknown, expired, or another browser's search); 400 `picks`, `target`,
  `categoryId` (must be a category on that tab), `qty`, `list` (not a list of that tab or General, or General with Track).
- How the server asks (`src/stores/node.ts`, through `http.ts` `setTransport`, only in the server's core build):
  `fetch` with the phone's own URLs and headers for its direct requests (woolworths.ts, coles.ts, aldi.ts,
  endeavour.ts; a built-in bottle shop or chemist's known search page, read for its JSON-LD or embedded data only),
  `User-Agent: Restock server (self-hosted grocery price tracker)` unless the shop's connection sets its own;
  https only, only the hosts in `SHOP_HOSTS` (the built-in shops' websites and search pages from shops.ts, and
  `api.aldi.com.au`, `api.danmurphys.com.au`, `api.bws.com.au`), no port, no sign-in part; a redirect only to
  another host of the same shop (at most 3); 10 s for each shop's whole search; 3 MB an answer (after unzipping);
  cookies in a jar for that one search, dropped when it ends; nothing outside a search (no timer, no background).
- Logged (srv_log activity): `shops-searched { tab, shops: { "<chain>": "<status>" } }` and
  `added-from-search { tab, tracked, listed, shops }`, by the browser. Never what was searched for, nor its length.

### v3, 0.9.5: Data (the web's Data tab)

Server side in `server/src/v3/data.mjs`. Every endpoint below is a browser session's (RestockWeb3: no session
401 `auth`, a bad MAC 401, a phone 403 `forbidden`); every 2xx answer is sealed, errors stay plain JSON.

**Spending is what gets ticked off, not receipts.** Server table `srv_spend` (household.db, so it's in the
encrypted backup and goes with Delete everything), one row a tick: `entry_id, checked_at` (ms; the key), `at`
(ISO of checked_at), `chain`, `section`, `item_id`, `product_id`, `text` (the item's name, else the line's),
`qty`, `price` (per pack), `total` (price × qty), `usual`, `special` (0/1), `src` (`line` | `price` | `none`).
- Noted by a sweep of `list_entries` after every merge and every change the server makes itself (Home
  Assistant, the web's own file, joins: whatever goes through the server's own file), and at start (so a server
  updated with ticked lines on its list fills it in). Idempotent.
- A line with `checked = 1` and `checked_at` set is one purchase. Price: the line's own `price` (per pack; the
  list totals price × qty), else the newest price on or before the tick of the item's products at the line's
  shop (its usual product first, then the same ones, then the ones it would also take), else, with no shop on the
  line, the cheapest such price of its usual and same products (and that's its shop), else `price` null
  ("ticked without a price", counted as `unpriced`). A one-off line found at a shop uses its `product`'s
  `storeProductId` for its product.
- `usual` is verdict.ts `computeStats().typical` ported (hasCard: the server can't know): the last reading of
  each day in the 183 days to the tick, the median of those not on special, else the median of the shops'
  "was" prices, else the shared history's `market.normal`. Saved on specials = Σ (usual − price) × qty over
  purchases with both known and usual > price.
- Unticked within 48 hours of the tick (the line still there, `checked = 0` with a later `checked_at`): that
  purchase is taken back. Ticked again: a new one (a re-tick within 48 hours of an earlier tick replaces it, as
  there was an untick between). A line cleared off the list keeps its purchase; one unticked later than 48 hours
  (needed again) does too. Lines and items with `demo-` ids aren't counted.
- Not noted when older than Auto delete's cut-off, or older than the last time statistics were deleted
  (`sync_meta srv_spend_floor`), so a line still ticked on the list doesn't come back after a delete.

**Reads**
- `GET /api/v3/data/summary` → `{ kinds: { prices: { count, products, archives, oldest, bytes }, receipts: { count,
  pinned, photos, oldest, bytes }, stats: { count, oldest, bytes }, logs: { count, activity, oldest, bytes },
  backups: { count (files), folders, oldest, bytes, nightly: false, keptDays: 30 } }, total, other, database,
  files, measured: "dbstat" | "estimate", disk: { free, size } | null, autoDelete: { months, cutoff }, resend:
  { at, next }, at }`. Bytes: SQLite `dbstat` pages of each kind's tables and indexes (an estimate from row
  lengths where dbstat isn't built in), plus `archive/` files (prices) and `photos/` files (receipts). The
  server makes no nightly copies of its own (the backup is a download), so "backups" is its trash: `archive/`
  and `photos/` files deleted or replaced, kept 30 days. `total` = household.db (+ WAL) + files/ + trash;
  `other` = what isn't in a kind (sync bookkeeping, sync files). `disk` from `statfs` on the data folder.
- `GET /api/v3/data/stats?period=<1–120 | all>` (months back from the start of this month, server's time zone;
  default 12) → `{ period, from (ISO | null for all), to, spending: { total, count, unpriced, months: [{ month
  "yyyy-mm", total, count, unpriced }] (every month in the period, oldest first) }, shops: [{ chain | null, total,
  count, unpriced }] (biggest first), sections: [{ section, name, total, count }] (by shopping list: `pantry`
  "Groceries", `keg`, `pharmacy` "Health", `general` "General" on its own; a line with none is the groceries'),
  saved: { total, count },
  itemsTracked (pantry items), productsTracked (with a price in the period), prices: { count, first (oldest date,
  all time), inPeriod }, top: <the first page of top> }`. 400 `period` otherwise.
- `GET /api/v3/data/top?period=&offset=(0…)&limit=(1–50, default 10)` → `{ items: [{ key, itemId | null, name,
  times, qty, total, lastAt, lastPaid: { price, chain, at } | null, usual | null, cheapest: { chain, price,
  productId, date } | null }], offset, limit, total }`, most often bought first. Lines without an item group by
  their words (`key` = `text:<words>`).
- `GET /api/v3/data/series?item=<item id>&period=` → `{ item: { id, name }, period, from, usual, chains: [{
  chain, productId, usual }], weeks: [{ week ("yyyy-mm-dd", the Wednesday a specials week starts),
  chain, price (the cheapest that week), special }], paid: [{ at, chain, price, qty }] (≤ 200) }`, over the
  item's usual and same products (or, with none, the ones it would also take). 404 `not-found` for no such item.

**Export: `restock-export` v1.** The browser builds the spreadsheet, CSV and full export file from it.
- `GET /api/v3/data/export` → `{ format: "restock-export", v: 1, app: "restock-server", version, at, house: {
  name }, autoDelete, tables: { items, products, categories, list, receipts, shops, settings, aliases,
  spending }, paged: { prices: { count, path, limit }, ticked: { count, path, limit } }, truncated: [<table>] }`.
  Rows are the household.db columns, cleaned: `items.same_product_ids`/`alt_product_ids` as arrays, `not_at`
  and `list.product` parsed; `receipts` are metadata only (`id, scanned_at, shop, chain, receipt_date, total,
  section, note, pinned, photos` (how many)), never their text or photos; `shops` = `[{ id, on, name?, website?,
  section?, removed?, branch?: { name, storeNo? } }]` from `shop:` and `branch:` rows; `settings` = the other
  household settings `{ k: value }`; `aliases` = `[{ words, item_id }]`; `spending` = all-time months as in
  stats. Small tables are capped at 50,000 rows (named in `truncated`).
- `GET /api/v3/data/export/prices?after=<id>&limit=(1–10000, default 5000)` and `…/export/ticked?…` → `{ table,
  rows, next }` (keyset pages: ask again with `after = next` until `next` is null). `prices` rows: `id,
  product_id, date, price, was_price, is_special, member_only, promo, source`; `ticked` rows: srv_spend's, with
  `id`. The full export file is the first answer with `tables.prices` and `tables.ticked` filled from the pages
  (and `paged` dropped).
- Never in it: loyalty cards and gift cards (no cards table at all; their numbers and PINs never reach household.db), Costco prices (a phone's Costco lines, products, prices and picks are never sent), receipt text, the
  passphrase or anything made from it, keys (household, server, owner, kex, phones'), sessions, the recovery
  key, the Home Assistant token or which phone runs it, `demo-` rows. A future import takes `format` and `v`
  first and refuses a higher `v`.
- 0.9.6: **never Costco's prices** (Declan, 11 Nov 2026): products with `chain` `costco` and their prices are left
  out (`paged.prices.count` too), a list line at Costco has `price` null and no price or unit price text in
  `product`, and a ticked purchase there keeps what and when but has `price`, `total`, `usual` null (the monthly
  `spending` totals still count it). When any were left out the answer says `withheld: { costco: { products,
  prices } }`. The web page leaves them out again itself (`exportFiles.ts withoutCostco`), so a 0.9.5 server's
  export saved from a 0.9.6 page has none either. (0.9.6 phones never send Costco's records at all.)
- 0.9.6: `summary.kinds.prices.imported` and `stats.prices.imported` count prices with `source` `imported`;
  a `series` week whose cheapest price was imported has `imported: true`.

**Manage.** Every delete is two steps on the web; the server checks both: body `{ …, typed, confirm: { c, proof }
}` (`confirm` as for Remove). Order: no `confirm` → 403 `confirm`; `typed` not exactly the word → 400 `typed`
(the challenge isn't used); a wrong passphrase → 403 `current` (counts towards the lockout). Passphrase sessions
only. Nothing here deletes the shopping list, the pantry (items, products), categories, household settings or
each product's newest price (prune's rule: `date < MAX(date)` for that product); pinned receipts stay. Prices
and receipts go quietly (no deletes go out to phones; a deleted receipt's sync record stays, so a phone's
unchanged copy doesn't bring it back). Logged in srv_log activity with who (`data-deleted`,
`deleted-everything`, `auto-delete-changed`, `phones-asked-to-resend`, `recounted`, `data-exported`).
- `POST /api/v3/data/delete { kinds: ["prices" | "receipts" | "stats" | "logs" | "backups"…], before?: ISO
  (in the past), typed: "DELETE", confirm }` → `{ deleted: { cutoff, prices, receipts, photos, archives, stats,
  logs, backups }, kinds, before }` (counts; `before` null = everything of those kinds). `prices`: price history
  (and `archive/` months wholly before the date); `receipts`: receipts and their photos (and those archive
  months); `stats`: srv_spend; `logs`: srv_log (activity and logs); `backups`: trash folders made before the date
  (all without one). Photos and archive files go to the trash (30 days) unless "backups" is in the same delete
  without a date; rows in household.db are gone at once. 400 `kinds` / `before`. An archive month goes only when
  everything in it goes (its prices only with `prices`, its receipts only with `receipts`) and never one holding
  a pinned receipt; the rest stay, and what was deleted of them stays out when one is read again (sync_meta
  `prices_floor`, `receipts_floor`).
- `POST /api/v3/data/delete { kinds, before?, dryRun: true }` (0.9.5 review) → `{ counts: <as deleted>, kinds,
  before, dryRun: true }`: exactly what that delete would take, by the same rules, deleting nothing. Any browser
  session (no passphrase, no typed word). The web's Step 1 (Clean up, Delete…, Auto delete) shows these numbers.
- `POST /api/v3/data/delete-everything { typed: "DELETE EVERYTHING", confirm }` → `{ ok, mode: "new", phones }`.
  The household goes: household.db, every file, the trash, the household's keys and Home Assistant settings
  (token included). Every phone is unlinked as by Remove: its next request is 401 `removed`, so it forgets the
  household and keeps all its own things (`notice = "server-removed"`); it can be added again later. The admin's
  sign-in and the server's settings (Auto delete, Let the web page search the shops) stay, and so does the
  browser session that asked (its page wipes its own copy). 0.9.5 (review): every other browser session ends
  (each one's copy of the household would go into the next one). Each household has an id (`state.house.id`)
  and each session notes the one it was made for (`house`; a session from before 0.9.5 is of the one there is);
  a browser's sync file from a session of another household is refused (409 `household`), and the web drops a
  copy whose pinned owner key isn't the household's (live.ts, the PWA's offline copy too). A browser's file
  whose session is gone is never merged again and goes to the trash (at a merge, a start, and nightly).
  The server is new again: Set up this server (`POST /api/v3/setup { name }`).
- **Auto delete** (replaces Keep data for; same `state.json settings.keepMonths`): `null` (off) or a whole
  number of months 1–120. **New servers start off**; a server that has a value keeps it (0.9.4's default was 12);
  a value that isn't one reads as 12. `GET /api/v3/data/autodelete` → `{ months, cutoff }`. `PUT
  /api/v3/data/autodelete { months, typed?, confirm? }` → `{ months, cutoff, was, deleted: <as delete> | null }`;
  turning it on or shortening it deletes at once, so it needs `typed: "DELETE"` and `confirm`; longer or off
  needs neither. 400 `months`. `PUT /api/v3/settings { keepMonths }` takes the same values with the same checks,
  and `GET /api/v3/settings` adds `autoDelete` (= `keepMonths`). Runs nightly (the 3 o'clock hour in the server's zone: `TZ`, else Node's local zone, else UTC; worked out with Intl, as the Data tab's months and days are,
  at most once a day, and once soon after a start), over prices, receipts and photos, archives, statistics and
  logs. The signed `server` row carries `keepMonths` as it is: a 0.9.4 phone reads a value other than 3, 6, 9, 12
  as no cut-off (it shows Auto delete as off, offloads all it would, and the server passes over what's older than
  its cut-off). 0.9.5 phones and the web (`parseServerRow`, `keepCutoff`, `SyncHousehold.keepMonthsOk`) take
  any whole number 1–120.
- **Ask phones to resend**: `POST /api/v3/data/resend` → `{ at, next }`; passphrase sessions only (403
  `passphrase`); at most once a day (else 429 `rate` with `retryAfter`, `next`, which the web shows). The server re-signs its `server` row with `resend: <ms>`. A 0.9.5 phone
  (`ServerSync.resendIfAsked`) seeing a `resend` it hasn't answered (`sync_meta server_resent`) writes its whole
  file again with every price it has (not just the last 60 days' changes), once. The server merges it as any
  file, so nothing doubles. A 0.9.4 phone's `parseServerRow` passes over the field. A resend that fails waits a
  day (`server_resend_wait`) and is then answered; one refused for its size is answered at once: never every round.
- **Recount**: `POST /api/v3/data/recount` → `{ added, removed, checked, repriced }`: the sweep, then every
  purchase priced again from what's known now (the line's own price if it's still there with that tick). The
  statistics are computed from srv_spend and prices when asked; nothing else is cached. Passphrase sessions
  only (403 `passphrase`), one at a time and not within 60 seconds of the last (429 `busy` / `rate` with
  `retryAfter`); 500 rows at a time, the server answering other requests in between.
- `POST /api/v3/prune` (0.9.4's Delete older data) stays as it was (passphrase, no typed word): prices, receipts
  (their photos and archive months) and logs, never the statistics; the Data tab uses `/api/v3/data/delete`.

### v3, 0.9.6: Data: Import

Server side in `server/src/v3/import.mjs`, the web in `src/server-mode/ui/DeskDataImport.tsx` and
`importFile.ts`. The file format, with an example, is `docs/restock-import.md`. An import merges a file ON TOP
of the server's data: it only adds **products** (the catalogue) and **prices** (price history). It never
replaces or deletes anything, never touches the shopping list, the pantry (items), categories, receipts,
settings or cards, and every price it adds has `source: "imported"` (apart from `auto`, prices a phone checked,
and `manual`, typed in). Costco is never imported (as it is never exported).

**The browser reads the file** (the Full export file `.json`, a restock-export v1; or the Data tab's CSV
`.zip`, of which it reads `Products.csv` and `Prices.csv`; a spreadsheet `.xlsx` is refused with what to use
instead), refuses one carrying anything secret (a table named like cards, keys, sessions, recovery; a field
named like number, pin, password, passphrase, secret, token, key, recovery, or a receipt's `text`, `photo`,
`pages`; a `data:` picture), and sends its products in chunks. Every chunk is checked again on the server.

All four endpoints are a browser session's (RestockWeb3: none 401 `auth`, a bad MAC 401, a phone 403
`forbidden`), POST, plain JSON bodies under the server's 256 KB request cap, every 2xx answer sealed, errors
plain JSON.
- A chunk's body: `{ products: [product…] }` (`import` and `n` too for `/chunk`), at most 2,000 products and
  5,000 prices (400 `chunk`). A product: `{ ref?, chain, store_product_id?, barcode?, name, brand?, size?,
  image_url?, qty?, qty_unit?, more?, prices?: [price…] }`; a price: `{ date, price, was_price?, is_special?,
  member_only?, promo? }`. Any other field, or a product or price that isn't an object, refuses the whole
  request (400 `fields` / `products` / `prices`) before anything is read or written. `more: true` is the rest
  of a product an earlier chunk started (the web splits a product with many prices between days).
- Each field (a product or price that fails is left out and counted in `problems`, the rest go on):
  `chain` a shop the server knows (a built-in shop or one of the household's own; not `other`; lower case,
  trimmed) else `shop`; `costco` (or any shop whose records stay on one phone) is counted in `costco`, never
  kept. `name` 1–200 characters after tidying (NFC, control characters out, spaces collapsed) else `name`.
  `store_product_id` text or a number (anything else: the product is left out, `shop-number`), ≤ 100, `brand`
  ≤ 100, `size` ≤ 40 characters (longer: left out). A `ref` is per shop: the same ref at two shops is two products. `barcode` 8, 12, 13 or
  14 digits (a GTIN-14 with leading zeros as its 13), else left out (`barcode-left-out`, a note). `image_url`
  only https, no user, password or port, and only from a host the household's own products at that shop already
  show pictures from, else left out (`picture-left-out`, a note). `qty` > 0 and ≤ 100,000 with `qty_unit` `g`,
  `ml` or `ea`, else both left out. At most 5,000 prices a product (`too-many-prices`, its prices counted in
  `product-ignored-prices`). A price's `date`: `yyyy-mm-dd` (noon that day in the server's zone), a date and
  time with no zone (the server's zone) or an ISO time with `Z` or an offset; from 2000 to no later than a day
  from now, a real day, else `date`. `price` a number from 0.01 to 10,000 (to the cent) else `price`;
  `was_price` kept only when above the price and ≤ 10,000; `is_special`, `member_only` booleans or 0/1 (absent
  false) else `flag`; `promo` ≤ 120 characters. The server's own `id`, `source` and `created_at` are never
  taken from a file.
- **Which product:** the one the server has with the file's `ref` as its id at the same shop, else the same
  shop and `store_product_id`, else the same shop and `barcode`, else (only for a product with neither) the
  same shop, name and size (ignoring case). An existing product is never changed. A new one gets `ref` as its
  id when that's free (and doesn't start `demo-`), else a new UUID; `created_at` now. The server holds at most
  50,000 products in all: past that an import adds no new ones (`full`, its prices `product-ignored-prices`).
- **Which prices:** one a day per product (the day in the server's zone): the newest of each day in the file
  (the others are counted in `skipped`). One the server already has that day at the same price is a duplicate
  (`skipped`); when the server has that day at another price, the newest wins: the import's is added only
  when it's later than the server's reading that day, else `skipped`. A day the product already has an
  imported price for (an earlier chunk or import) is `skipped` too, so one a day holds across chunks: the
  first one in wins. Nothing already there is changed.
- `POST /api/v3/data/import/check { products }` (the dry run; any browser session) → `{ products: { add,
  matched }, prices: { add, skipped }, costco: { products, prices }, problems: { "<code>": n } }`. Writes
  nothing. A product with `more` the server doesn't have counts as one an earlier chunk counted.
- `POST /api/v3/data/import/start { confirm }` (a passphrase session, 403 `passphrase`; the passphrase again
  as for Remove: no `confirm` 403 `confirm`, a wrong one 403 `current`, counting towards the lockout) → `{
  import: "<id>", until, idleMs, limits }`. One import at a time on the server: another going is 409 `busy`
  (said before the passphrase is used). At most 10 starts an hour (429 `rate`); 507 `full` with under 200 MB
  free on the server's disk.
- `POST /api/v3/data/import/chunk { import, n, products }` (the same session) → `{ products: { added, matched
  }, prices: { added, skipped, toPhones }, costco, problems, n, next }`. Chunks in order from 0 (409 `order`
  with `next`). Each chunk is one transaction: all of it or none. At most 25,000 products and 500,000 prices an
  import (413 `too-many`). An import is over after 10 minutes without a chunk, or 2 hours in all (410
  `import-gone`, also for another session's id); what its chunks added stays.
- `POST /api/v3/data/import/finish { import, cancelled? }` → `{ products, prices, costco, problems, chunks,
  how: "finished" | "cancelled" }`. Cancel is `cancelled: true`. Logged in srv_log activity with who:
  `data-imported` (or `data-import-stopped` for a cancelled or abandoned one) `{ how, products, prices,
  skipped, ignored, costco }` (counts only).
- `check` and `chunk` together: at most 300 a minute per browser session (429 `rate` with `retryAfter`; the
  web waits and goes on).
- **What the phones get:** products are written by the server (its sync triggers: device `srv-<sid>`, origin
  the browser's `web-<id>`, as Track from a web search), so they go out in the server's file to every phone
  sharing that shop's tab. Of a product's prices, only its newest imported one goes out with them, and only
  when it is newer than any price the server had for it and from the last 60 days (as the server's file carries
  recent prices). The older history is written quietly (no sync record, as the months phones offload are): it
  stays on the server, in the Data tab's charts and counts, the export and the encrypted backup. This keeps the
  server's file small for the phones. 0.9.5 phones and pages take these rows as any of the server's
  products and prices (no new record kind; `source` is a plain text column they copy and show as checked).
- The web: Import data on the Data tab, below Download your data: Choose a file → Checking the file (the dry
  run, chunk by chunk, Cancel) → Step 1 ("Will add 12,000 products and 90,000 prices, skip 300 already there,
  ignore 12 it couldn't read", why rows were left out, Costco left out, the tables not taken) → Step 2 (the
  passphrase) → Importing (how far, Cancel stops after the chunk being sent, the page asks before it's closed)
  → Imported / Import stopped. The web sends at most 500 products and 2,500 prices a request so the server
  answers everyone else in between. Files up to 100 MB (300 MB unzipped).

## 0.9.6: what changed on the wire

- **No new record kinds.** Move to another list is ordinary list changes: between Groceries and General the line is updated in place; across tabs it is a new line plus a delete of the old one. A 0.9.5 phone or server needs nothing.
- **Costco** (0.9.6 only; see 0.9.7 below): a 0.9.6 phone never sends Costco products, prices, list-line details or item picks that point at Costco products.
- **Gift cards and Cards in the web page:** never sent. Gift cards live in a phone-only table; the browser keeps cards in its own storage.
- **Import:** see the "Data: Import" section above and [restock-import.md](restock-import.md).
- **Price checks at a set time** are per phone (`checkTime`), not a shared setting.

## 0.9.7: what changed on the wire

- **Costco is an ordinary shop.** Picked with the household's shops (`enabledChains`, a household setting like the others), its products, prices, list lines and item picks sync like any shop's, and the server keeps, exports and imports them (`NEVER_SHOP` no longer matches any shop; `withheld.costco` is never sent). A 0.9.6 phone still keeps its own Costco records back; a 0.9.7 phone sends them. No new record kinds.
- **The server's web search may ask Costco** when "Let the web page search the shops" is on, still only when Search is pressed.
- **Phones ask Costco from inside Costco's own page** (`storeFetch`, chain `costco`), its product search first (`/rest/v2/australia/products/search`), then the search page. A sign-in there (`accounts.costco`) gives member prices.

## 0.9.8: what changed on the wire

- **Nothing.** No new record kinds, endpoints or settings keys. Costco's product search asks for 48 a page and pages with `currentPage` ("Get more from Costco"). Notifications carry a `restockAction` extra (`item:<id>`, `deals`, `catalogue`, `daily`, `cards`, `sync`, `updates`) that only the phone itself reads.

## 0.9.9: what changed on the wire

- **Nothing.** Stock tags, the shop Edit sheet and branch advice use what phones already sync (`products.in_stock`, `in_stock2`, `stock_at`, the shop picks).

## 0.9.10: what changed on the wire

- **Nothing.**

## 0.9.11: what changed on the wire

- **Nothing between phones and the Restock server.** The settings key `priceHelper` (`{ enabled, url, key, searches }`) and the `priceHelper` / `priceHelperOutbox` store entries stay on the phone that has them: they're never synced, and the key is left out of backups. A price helper phone posts `{ format: "restock-helper", version: 1, chain, products }` to the restock-prices collector's `POST /helper/prices` (with `Authorization: Bearer <HELPER_KEY>`), never to the Restock server. "Pick my …" with **Add to list** replaces the line (a new list line, the old one deleted), as Search the shops already did.

## 0.9.12: what changed on the wire

- **Nothing.** The price helper's `priceHelper` store entry gains `runningSince` (this phone only, never synced). The restock-prices collector's STATUS.md gains a "From the price helper phone" column.

## 0.9.13: what changed on the wire

- **Nothing between phones and the Restock server.** The settings gain `marketData.days` (56, 182 or 365; 56 when missing) and `beta: { enabled }`; `sharePrices` is unchanged (on unless `"no"`). The store entries `installId` and `feedbackOutbox` stay on the phone (never synced or backed up).
- **Day-one downloads** read only the restock-prices collector's `window/<shop>-<days>d.json.gz` files (`{ format: "restock-window", v: 1, chain, days, from, to, products: { <shop product id>: [[day, cents, flags?], …] } }`, with `day` counted from `from`; flags 1 = special, 2 = member price), and `window/index.json` for their sizes. Phones no longer read hotprices.org or the collector's `latest/` files.
- **Feedback** goes from the app (phone or web page) to the collector's `POST /feedback`: `{ format: "restock-feedback", v: 1, install, kind: "wrong" | "idea" | "like" | "other", message, email?, app, platform: "android" | "web" | "iphone", device?, screen?, diagnostics?, screenshots?: [{ type, data (base64) }] }`, at most 3 screenshots and 8 MB. It answers `200 { ok, id }`, `400`, `413` or `429 { error }`. The web app's Content-Security-Policy allows `connect-src` to `https://restock-prices.plenty.family` for this, and nothing else new.

## 0.9.14: what changed on the wire

- **A phone may read the statistics.** `GET /api/v3/data/summary`, `/stats`, `/top` and `/series` now answer a household phone's signed request too (Settings → Your data on the phone), with the same JSON a browser gets, not sealed (the phone signs every request). Everything else under `/api/v3/data/` stays a browser session's (403 for a phone).
- **Settings:** `marketData.every` (`"weekly"`, the default, or `"daily"`); `marketData.days` now follows `historyWeeks` (8, 26 or 52 weeks: 56, 182 or 365 days; 4 and 13 weeks become 8 and 26). The store entries `priceShareOutbox`, `priceShareCursor` and `priceShare`, and the `spend_log` table (spending from ticks), stay on the phone: never synced or backed up.
- **Send prices back** (phones, not the server): `POST https://restock-prices.plenty.family/share/prices` with `{ format: "restock-share", v: 1, install, chain, products }`, `chain` one of coles, woolworths, aldi, costco, at most 2000 products, each `{ id, chain, store_product_id, name, brand?, size?, barcode?, image_url?, day, price: { price, was_price?, is_special, member_only, promo? } }`. Only prices read from the shop (price checks' `source = "auto"` and search results), never `manual` or `import` ones. It answers `200 { ok, kept }`, `400`, `413` or `429`.
- **restock-prices' `window/index.json`** gains `updated` and, per shop, `full` (the day of its last full collection) beside `to`. A phone set to weekly downloads once `full` is newer than what it has; daily, once `to` is.

## 0.10.0: what changed on the wire

- **A phone may add spending.** `POST /api/v3/data/spend` (a household phone's signed request only; 403 for a browser) with `{ rows: [ { entry_id, checked_at, at?, chain?, section?, item_id?, product_id?, text, qty?, price?, total?, usual?, special? } ] }`, at most 5,000 rows: the ticks a phone counted on its own (Settings → Your data) before it joined, or while the server was out of reach. `checked_at` is in milliseconds. Rows are added with `src = "phone"` and `INSERT OR IGNORE` on (`entry_id`, `checked_at`), so sending twice adds nothing; sample items (`demo-…`), rows with no text, and rows older than Auto delete keeps are skipped. It answers `{ added, skipped }` and notes `spending-added` in the activity log. Nothing can be changed or deleted this way.
- **Settings:** `yourData: { server }` (on unless `false`): whether Your data reads the server's figures and the phone sends its earlier spending (once, then the store entry `spendSentToServer`, which stays on the phone). `sharePrices` now defaults to `"yes"`, and `marketData.enabled` is always the same as `sharePrices !== "no"` (one switch, Shared prices). The store entry `sharedPrices010` (the one-time question for a phone that had sharing off) stays on the phone.
- **Shared prices** (was Send prices back; phones, not the server): a phone only sends prices it read itself. A price row that came from another device (in `sync_log` with another `device`) isn't sent. Turning Shared prices back on moves `priceShareCursor` to the newest price and empties `priceShareOutbox`, so nothing read while it was off is sent.

## 0.10.1: what changed on the wire

- **Your data, sealed.** A phone may send `X-Restock-Seal: rsf1` with any request a phone may make under `/api/v3/data/`. The answer is then `application/x-restock-sealed`: the JSON, plus `reqN` (the request's own nonce, `n=` in its `Restock2` signature), sealed as an RSF1 file with the household's current serverKey. The phone opens it with any serverKey it knows and refuses an answer whose `reqN` isn't its request's. `POST /api/v3/data/spend` may likewise be sent sealed (`Content-Type: application/x-restock-sealed`, the body `{ rows }` sealed the same way); a body no serverKey opens is `400 sealed`. Requests without the header are answered plain, as before (0.9.14 and 0.10.0 phones).
- **Shopping list totals** (phones and the web app, not on the wire): shopping around and each shop's items from other shops pick from the same per-shop lines that are added up, measured the way the list is set (same shopping or at the till), in stock first, and only at the shops being compared.
