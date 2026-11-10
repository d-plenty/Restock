# Restock 0.9.4: server-first households (protocol v3), design

Status: P1 (core and formats) is built; P2–P5 are built from this file and P1's code. The exact
wire formats (bytes, fields, associated data, salts) are in `docs/server-protocol.md` section "v3",
with test vectors in `tools/sync-test/vectors-v3.json`; where this file and that section differ in
detail, that section wins. This file stays the contract for the design and the work packages.

Words used here: **phone** = Restock on Android; **web** = the Restock web build served by the
server; **server** = `server/` (its own repo); **house** = a household whose owner is the server;
**phone household** = a 0.9.x household owned by a phone (Wi-Fi or folder sync).

## 1. The idea in one paragraph

The server becomes a member of the household that never sleeps, and its owner. It holds the
household key and the owner signing key, opens every sealed file the devices leave on it, merges
them into a real Restock database (the same schema and merge rules as a phone, by running the
existing TypeScript engine in Node), and writes a file of its own, `restock-sync-srv-<sid>.bin`,
like any other device. Everything that goes over the wire stays exactly as v2 seals it (RSF1 files
sealed with the serverKey, every phone request signed with the phone's ECDSA key), so plain http
on the LAN stays encrypted and most of the phone's sync code is unchanged. What's new is small:
who owns the household, how keys reach phones (sealed to a per-phone ECDH key instead of by an
owner phone), how browsers get access (a session instead of a passphrase vault plus phone link),
per-phone sharing, and the jobs the server can now do because it can read (Home Assistant,
history, stats, logs, retention).

## 2. Decisions (with reasons)

| # | Decision | Why |
|---|---|---|
| D1 | **The server holds the household key**; data at rest on the server is **readable** (a plain SQLite database). No at-rest encryption with a key kept in the same volume. | Keeping the v2 file format (sealed in transit) is the smallest change. A key next to the data protects nothing; saying "readable at rest" is honest. Recommend host disk encryption (an encrypted TrueNAS dataset) in the README. |
| D2 | **The server is the owner**: `owner = srv-<sid>`, it holds `owner_priv` and signs the household record. Phones verify with their existing `owner_pin`. | Phones already trust only owner-signed household changes. Handing the existing owner key to the server means 0.9.3-joined phones keep their pin; nothing to re-pin. |
| D3 | Storage is **`node:sqlite`** (`DatabaseSync`), not JSON files. | The engine needs SQL and is synchronous on purpose; `DatabaseSync` is synchronous. Years of prices need indexes. The schema (with its sync triggers) is `src/lib/sql/schema.ts` `MIGRATIONS`, reused as-is. |
| D4 | The server **reuses `src/server-mode/engine.ts`, `crypto.ts`, `round.ts` helpers, `src/lib/sharedSettings.ts`, `haSync.ts`, `haMatch.ts`, `sql/schema.ts`** through one bundled file, `restock-core.mjs`, built from the Restock repo at the same tag as the web app. | One merge implementation for web and server, already parity-tested against Java (`tools/sync-test/web-parity`). |
| D5 | **Still one file per device**, read whole, as v2. No per-change rows. Phones keep reading every device's file (the server's included). | Zero change to `SyncFolder.readOthers`/`writeOwn` and their tests. Files are only re-read when their `version` changes. |
| D6 | **Removing a phone rekeys** the household (new `keyv`), done by the server. A phone that **leaves** does not cause a rekey. | Server access control alone stops a removed phone using the server, but the household key also opens Wi-Fi sync and every sealed file in transit. Rekeying is cheap now (no owner phone needed). A phone that leaves deletes its own keys (`forget()`), as in 0.9.x. |
| D7 | Keys reach phones **sealed to each phone's own ECDH key** (`kex`), registered when it joins: in the join answer, then in `keys/<device>.bin` after a rekey. | Replaces the owner phone's secret-sealed keys file and the browsers' `webkeys/`. Works with phones away from home. |
| D8 | Browsers use a **session with its own key**: challenge-response login (the passphrase never crosses the wire, not even as v2's static authKey), every request MACed, every answer with household data sealed. The server hands the session the serverKeys. **No vault, no "Link with a phone"** in a house. | The server can read now, so it can give access itself. Sealing the session keeps a passive LAN listener out, as for phones. |
| D9 | **What-this-phone-shares is enforced on both sides**: the phone never sends an unshared tab (existing `collect` with `tabs()`), and the server drops anything outside what that phone declares in its sealed file (`shares`). Receivers keep filtering by their own tabs (existing `apply`). | Defence in depth; the phone side alone is what 0.9.x already relies on. |
| D10 | In a house, the household-wide switches (`tabs`, `receipts`) are **all on**, signed by the server, and each phone's own choice (`sync_meta tabs`, `share_receipts`, `share_cards`) decides. **After a handover or a bring they keep the household's old values** until every member that isn't removed is on v3 (upgraded or joined); then the server signs all three tabs and `receipts = "1"` and logs it (`household-widened`). A fresh house starts all on. | Reuses the existing "phone's tabs ∩ household's tabs" rule unchanged. A 0.9.3 phone follows the household's tabs, so widening while one is still on it would make it start sharing Keg, Pharmacy or receipts (over Wi-Fi too) because the household moved (decided 10 Nov 2026). |
| D11 | **Turning a tab off on a phone** stops sending from now on; what it already shared stays on the server (like Remove). The sheet says so. | Consistent with decision 3. The existing "moved" deletes carry the row's own stamp, so they never win elsewhere; nothing is deleted by accident. (See open question Q2.) |
| D12 | In a house, **Home Assistant runs only on the server.** A phone in a house can't run its own, whether or not the server runs it. | Declan's "the server is the house": one list, one token, 24/7, no doubles. See section 9. |
| D13 | **Folder/WebDAV sync is turned off** on a phone once its household is a house. Wi-Fi sync stays. | Rekeys can no longer be delivered through a folder (no owner phone writes the keys file), and the server already does "away from home". |
| D14 | **Retention is an input filter plus a quiet prune**: the server never takes in, and periodically drops (without sync deletes), prices and receipts older than "Keep data for". Default **12 months**. | Pruning through the triggers would send deletes to every phone. |
| D15 | The **backup download is encrypted** with a backup passphrase typed at download (scrypt → AES-256-GCM). | It leaves the server for a laptop's Downloads folder, and (D1) the server's data isn't sealed at rest. |
| D16 | The **recovery key** stays: the server keeps the household's sealed recovery copy current, and the web shows the recovery key once to save. | If the server is lost, a phone can take the household back as owner with 0.9.0's Take over. Costs nothing: the code exists. |

## 3. Data on the server

```
/data
├── state.json        v2 contents, plus: mode ("new" | "v2" | "v3"), sid, devices[] with
│                     { label, pub, kex, myPub, added, lastSeen, status: active|removed|left,
│                     statusAt, api }, web sessions { kind, keyHash, key (session key), created,
│                     lastUsed, label }, account.loginKey, settings { keepMonths }
├── keys.json  (0600) server kex key pair; owner key pair; household keys { "<keyv>": key } (every
│                     version it has; a handover brings only the current one and oldkey), serverKeys
│                     { "<keyv>": serverKey } (every version, never pruned); keyv; hid; per-phone
│                     secrets (owner_secrets);
│                     recovery; Home Assistant { address, entity, enabled, token }
├── household.db      node:sqlite, WAL: Restock's schema (MIGRATIONS) + srv_log
├── files/            as v2, plus keys/<device>.bin and restock-sync-srv-<sid>.bin
├── trash/, tmp/      as v2
└── activity.jsonl    v2 mode only; moved into srv_log at handover
```

- **`household.db`** is opened with `DatabaseSync`, `PRAGMA journal_mode=WAL`, and `MIGRATIONS`
  applied in order exactly as `initDb` does (the core exports a `migrate(db)` that runs them).
  `sync_meta.device` = `srv-<sid>`, `name` = the house's name, `owner_pin` = the owner key's SPKI.
  The engine runs on it through the core's `syncDbOfNode(db)` (`query` = `prepare().all()`, `exec` =
  `prepare().run()`, `transaction` = nested `BEGIN`/`COMMIT` as `sqldb.ts` does). `migrate(db)` is
  async (it runs the app's own `migrate`, data steps included, through `sqlDriverOfNode`).
- **`srv_log`** `(at TEXT, kind TEXT, what TEXT, device TEXT, detail TEXT)`, indexed on `at`: the
  activity (who uploaded, joined, was removed, signed in) and the logs (merge results, Home
  Assistant rounds, errors), both pruned by "Keep data for". Never contents, never secrets.
- **`keys.json`** is separate from `state.json` so it can be 0600, written atomically, and
  excluded from logs and `GET` answers by construction.
- **Node version.** `node:sqlite` is unflagged from Node 22.13.0 (it still prints an
  ExperimentalWarning). Checked here: Node 22.23.4 runs `DatabaseSync` with no flag (SQLite
  3.53.4). The Dockerfile's `node:22-alpine` floats to the newest 22.x, so it works today, but:
  pin `NODE_IMAGE=node:22.23-alpine` (and the web stage's image to the same minor), set `engines`
  to `>=22.13`, start with `node --disable-warning=ExperimentalWarning src/server.mjs`, and have
  `server.mjs` check `process.getBuiltinModule?.('node:sqlite')` at start and exit with "Restock
  server needs Node 22.13 or newer" otherwise. The Home Assistant app inherits the image.

**How the server gets the core.** The Restock repo gets `vite.core.config.ts` (Vite 8 `ssr` build,
target node22, one ES module, every dependency bundled in its plain build: noble, fflate; the result
imports nothing at all) and `npm run build:server-core`, writing `server/core/restock-core.mjs`, or
`$SERVER_CORE_OUT/restock-core.mjs` (use that from the Dockerfile and `scripts/core.mjs`). Entry
`src/server-core/index.ts` re-exports: `WebSyncEngine` and the engine helpers (`ownerOnly`,
`fileDevice`, `isSyncFile`, `allowedNameV3`, `serverFileName`, `keepCutoff`, `parseServerRow`,
`parseShares`, …), all of `crypto.ts` (RSF1, v2 link, RSJ3/RSE3/RSH3/RSA3, login and session keys,
request MACs, PKCS#8, the recovery copy), `signedText`/`signText`/`signWithPkcs8`/`verifySig`,
`applyRows`/`settingChangeOk`/`checkListRow`, `syncRound` (also as `haSyncRound`), `restApi`,
`haLists` and `haLineId` from `haSync.ts`, `matchKey`/`parseLine`, `MIGRATIONS`, `migrate`,
`syncDbOfNode`, `sqlDriverOfNode`, and `CORE = { version, protocol: 3 }`. The Dockerfile's web stage already clones Restock at
`RESTOCK_REF` and runs `npm ci`; it also runs `npm run build:server-core` and copies `core/` into the
image beside `public/app/`. `WEB=local` needs `core/` in the build context too. `core/` is
git-ignored in the server repo; `npm test` there first runs `scripts/core.mjs`, which builds it from
`$RESTOCK_DIR` (default: the parent folder when it is a Restock checkout, as in the dev tree) and
fails with that instruction otherwise. The server refuses to start in v3 mode if `CORE.protocol` isn't
3.

**Engine changes for the server** (`engine.ts`, small, parity-tested): a constructor option
`{ role: 'web' | 'server' }`. `role: 'server'`:
- `ownFile` leaves out only `cards` (the web leaves out `prices`, `household`, `cards`). It carries
  prices changed in the last 60 days, like a phone's server file, and `seen`.
- Household rows the server writes go through a new `writeHousehold(k, v | null)`: the change goes
  through the triggers (stamped, noted as `srv-<sid>`), then its `sync_log` note gets the signature
  from the `sign` option (`signWithPkcs8(owner_priv, signedText(entry))`), as a phone's collect signs.
- `takeFile` also applies the device's declared `shares` (D9) and the retention cut-off (the
  `keepFrom` option) before `apply`; `takeArchive` the cut-off. Also new: `prune(cutoff)`,
  `compact()`, `serverRow()`, `sharesOf(device)`.
- Cards are still blanked as they come in (`stripCard`): card numbers never reach `household.db`.

## 4. Keys and trust

**Server keys** (made at first start of a 0.9.4 server, kept in `keys.json`):
- `kex`: ECDH P-256. Its public key is in every v3 QR code (`k=`), so a phone pins the server from
  the code it scans, as v2's link code pinned the browser.
- `owner`: the household owner ECDSA key. Made at **Set up this server**, or received in a
  handover. `owner_pub` in the household record, as in 0.9.0.

**The household record in a house** (all signed by the owner key): `name` (the house's name),
`owner = srv-<sid>`, `hid`, `owner_pub`, `tabs = "pantry,keg,pharmacy"`, `receipts = "1"`,
`recovery`, `member:<device>` for the server and each phone (`{ name, pub }`, `pub` = the phone's
own household signing key `my_pub`), `removed:<device>`, and one new owner-only row:

`server` = `{ v: 3, sid, home, away, kex, keepMonths }`

It tells phones where the house is (for phones that join through the household, below), the
server's kex key (trusted because the owner signed it), and the retention window for offload.
0.9.4 adds `server` to `ownerOnly` in `SyncHousehold.java` and `engine.ts`. A 0.9.3 phone takes it
in through `legacyAllowed` (its author is the owner) and ignores it.

**A phone's keys for the server:** `server_dev_priv` (ECDSA, as v2, signs requests) and new
`server_kex_priv` (ECDH, receives keys). Both in `SECRET_KEYS`, sealed by `SyncKeystore`.

**Joining with an Add a phone code.** The admin types a label ("Sister's phone"); the server makes
an invite remembered with that label (10 minutes, once). QR:
`restock-server:3?h=<home>&a=<away>&i=<invite>&k=<server kex SPKI b64url>`.
The phone posts `POST /api/v3/join` `{ invite, device, name, pub, kex, myPub, n }` (`n` = 16 random
bytes). The server answers `{ sealed }`:

```
key    = HKDF-SHA256(ikm = ECDH(server kex, phone kex), salt = n, info "restock-join-v3", 32)
sealed = 12-byte nonce + AES-256-GCM(key, aad "RSJ3" + device, JSON {
  format: "restock-join", v: 3, device, label, seed,
  household: { name, hid, sid, owner_pub },
  keyv, keys: { "<keyv>": "<household key b64url>" },   // every version the server has
  serverKeys: { "<keyv>": "<serverKey b64url>", ... every version },   // older files stay readable
  secret,                       // this phone's secret, for the recovery copy (D16)
  server: { home, away, keepMonths } })
```

Only the holder of the `kex` key in the QR can make something that opens, so a swapped server is
caught. The phone pins `owner_pin = owner_pub`, stores the keys like a joined phone, shows
**"This phone was added as Sister's phone on Declan and Sarah"**, and asks for its own label for the
server ("Home" by default, `sync_meta server_label`, local only). The server signs
`member:<device> = { name: label, pub: myPub }`. `seed: true` only for the first phone in a fresh
house: that phone seeds `household_settings` from its own settings with stamp 1 (0.9.3's owner
seed, moved); otherwise nobody seeds.

**Joining through the household** (phones of a phone household brought onto a server, section 7):
a 0.9.4 phone that sees an owner-signed `server` row but isn't on the server shows "Your household
now lives on Declan and Sarah's server. Connect this phone?" and posts `POST /api/v3/join`
`{ member: true, device, pub, kex, n, sig }` without an invite, `sig` = ECDSA by its household
signing key over `memberJoinText` (`restock-member-v3`, device, pub, kex, n, one per line); the server
checks it against `member:<device>.pub` in its record. Same
answer. The label is the member's name.

**Rekey on Remove.** The server: new household key, `keyv + 1` (old ones kept for old files),
`removed:<device>` signed, member row deleted, recovery copy resealed, and for each active phone
`keys/<device>.bin` = `RSE3` + nonce + AES-GCM(HKDF(ECDH(server kex, phone kex), info
"restock-keys-v3"), aad "RSE3" + device, `{ keyv, keys }`). Only that device may read its
`keys/` file. A phone takes only a higher `keyv` than it has (as `takeRekey`). A phone that was
offline gets it at its next round; until then Wi-Fi sync with it pauses (different keys), as in
0.9.x when a phone missed a rekey. Removed and Left phones' files, archives and photos stay.

**Request signing** is v2's, unchanged (`Restock2 d=, t=, n=, s=`, ECDSA over method, path, time,
nonce, body hash; 5-minute clock window; nonces kept 11 minutes), on `/api/v3/...` paths.

**Plain http on the LAN, phones.** Every byte of household data a phone sends or gets is RSF1/RSJ3/
RSE3-sealed; every request is signed; the server's identity is pinned from the QR (or from the
owner-signed `server` row). A passive listener learns sizes and times; an active one can block or
delay but can't read, forge or replay. Retention (`keepMonths`) comes from the signed record, not
from an unsigned answer, so a MITM can't make a phone drop history.

**Browsers (D8).** `loginKey = HKDF(authKey, info "restock-login-v3")` (authKey is v2's PBKDF2 half,
so the passphrase and its salt are unchanged). The server stores `loginKey` (secret at rest, which
D1 already accepts) and keeps v2's scrypt hash for v2 mode. It learns `loginKey` from the setup
page (fresh server) or from the first v2-style login after the update.
1. `GET /api/v3/login/challenge?user=` → `{ salt, c, kex }` (`c` 32 random bytes, once, 2 minutes;
   a fake stable salt for unknown users, as v2).
2. Browser makes an ephemeral ECDH key `e`; `POST /api/v3/login`
   `{ user, c, epub, proof: HMAC(loginKey, "restock-login-v3\n" + c + "\n" + epub) }`.
3. Server checks it (same lockouts as v2), makes session `s` and
   `sessionKey = HKDF(ECDH(server kex, epub) ‖ loginKey, salt c, info "restock-session-v3")`.
   Answer `{ session: s, expires, sealed: RSF1(sessionKey, { keys: {keyv: serverKey}, keyv,
   webId, household: { name, owner_pub } }) }`.
4. Every later request: `Authorization: RestockWeb3 s=<s>, t=<ms>, n=<nonce>, m=<HMAC(sessionKey,
   METHOD\nPATH\nt\nn\nhex(sha256(body)))>`; answers with household data are RSF1 with
   `sessionKey` (`Content-Type: application/x-restock-sealed`); request bodies with secrets
   (passphrase change, Home Assistant token, backup passphrase) likewise. No cookie, so no CSRF.
   The browser keeps `sessionKey` in `sessionStorage` (or `localStorage` with "Keep me signed in
   on this computer"; 30 days unused).
- **Sign in with a phone**: `POST /api/v3/qrlogin { epub }` → `{ id, kex, expires }`, code
  `restock-login:3?u=&s=<id>&k=<epub>`; the phone checks the host and posts a signed approval (no keys
  inside: the server gives them). Session key from ECDH alone (HKDF salt `id`), 12 hours.
- **Sign out everywhere** ends every session. The web's Browsers list shows each session and can
  end one.
- **Honest limit:** over plain http the server also serves the page's JavaScript, so an *active*
  LAN attacker could change it. The README says: use https or Tailscale for the web page; plain
  http is fine for phones.

**What a stolen phone can still do.** Until it's removed: everything that phone could do (its
local data, sync, read what's shared). After **Remove**: the server refuses it (401 `removed`, it
then forgets the household and keeps its own local copy, as 0.9.x); it has old keys, which open
only traffic and files from before the rekey; it can't Wi-Fi sync with the others (new key). Its
local data is protected by the phone's lock and Android's key store, as today.

## 5. API v3

v2 stays, byte for byte, while the server is in `v2` mode. New endpoints are under `/api/v3`.
Errors keep v2's shape `{ error, message }`.

| Method and path | Who | What |
|---|---|---|
| `GET /api/v3/health` | anyone | `{ ok, version, api: 3, mode, house? }` (house name only in v3) |
| `POST /api/v3/join` | invite or member sig | section 4 |
| `POST /api/v3/upgrade` | phone (v2 key) | a phone already on the server after handover: `{ kex, myPub, n, ha? }` registers `kex` (and `myPub`), answers like join (sealed with `n`); may carry `ha` (section 9, sealed with the same `n`) |
| `GET /api/v3/files`, `GET/PUT/DELETE /api/v3/files/<name>` | phone or web session | v2's rules, plus: `restock-sync-srv-*` server-written only; `keys/<device>.bin` readable by that device only; no `webkeys/`, no `restock-sync-keys-*.json`; device ids `srv-…`/`web-…` can't join |
| `DELETE /api/v3/devices/<me>` | phone | Leave: status `left`, member row deleted (no rekey) |
| `POST /api/v3/handover/<token>` | owner phone (v2 key) | section 7 |
| `POST /api/v3/qrlogin`, `GET /api/v3/qrlogin/<id>`, `POST /api/v3/qrlogin/<id>` | browser / phone | as v2, keys from the server |
| `GET /api/v3/login/challenge`, `POST /api/v3/login`, `POST /api/v3/logout` | anyone / session | section 4 |
| `POST /api/v3/setup` `{ name }` | session, mode `new` | Set up this server: makes the house (section 7) |
| `GET /api/v3/phones` | session | `[{ device, label, name, status, statusAt, added, lastSeen, version, shares }]` (incl. Removed and Left) |
| `POST /api/v3/phones` `{ label }` | session | `{ code, expires }` (the v3 QR) |
| `PATCH /api/v3/phones/<d>` `{ label }`, `DELETE /api/v3/phones/<d>` | session | Rename (signs `member:<d>`), Remove (D6) |
| `GET /api/v3/browsers`, `DELETE /api/v3/browsers/<s>` | session | |
| `GET/PUT /api/v3/settings` | session | `{ name, keepMonths: 3|6|9|12|null }` (`null` = Until I delete); `POST /api/v3/prune { before }` deletes older data now |
| `POST /api/v3/passphrase` | session | sealed `{ c, proof (current), salt, auth }` |
| `GET /api/v3/recovery` | session | the recovery key, to save |
| `POST /api/v3/backup` | session | sealed `{ passphrase }` → the encrypted backup (D15) |
| `GET /api/v3/activity`, `GET /api/v3/logs` | session | from `srv_log`, newest first |
| `GET/PUT /api/v3/homeassistant`, `POST …/test`, `POST …/sync` | session | section 9 (token write-only) |
| `GET /api/v3/history?product=&from=` | session | prices for one product from `household.db` (years) |
| `GET /api/v3/stats?months=` | session | per month: receipt totals per tab, products tracked, specials seen |
| `GET /api/v3/specials` | session | latest special per product from the last 14 days of prices phones shared |
| `POST /api/v3/handover` | session, mode `v2` | `{ token, code }` for the handover QR |

**A round, phone (v3):** list files; take a higher key from `keys/<device>.bin` if its version
changed; read each changed `restock-sync-*.bin` (the server's included) as `SyncFolder` does today;
write its own file when its mark changed; offload (section 8). Its own file is v2's plus a top-level
`shares: { tabs: [...], receipts, cards }`. It no longer writes `webkeys/` or a keys file.

**A round, server:** on each accepted `PUT` of a sync or archive file, a merge is queued (1 second
debounce): open with the serverKeys, `takeFile`/`takeArchive` with the retention filter, then
`ownFile` → write `restock-sync-srv-<sid>.bin` if its mark changed. Synchronous on the event loop
(a household's file merges in milliseconds); one merge at a time.

**What's reused unchanged:** file names and RSF1, archives and photos (and the trash), signing,
nonces, rate limits, lockouts, trusted proxies, the device-taken rule, the 60-second phone poll
(`anythingNew`) and PollGate.

## 6. What this phone shares

- At join (and later in Sync and backups → Your server → What this phone shares):
  **Pantry and shopping list** on; **Keg** and **Pharmacy** off, turning one on asks "Everyone on
  this server will see what you buy here. Share it?"; **Receipts** off; **Loyalty cards** off,
  "best kept on your phone". Stored as `sync_meta tabs` (existing), `share_receipts` (new), and
  `share_cards` (existing).
- `SyncEngine.shareReceipts()` (and `engine.ts`) becomes `household receipts == "1" &&
  share_receipts != "0"`: unset means on, so phone households behave exactly as 0.9.3; a v3 join
  writes `"0"`. Turning receipts on re-sends receipts, as `setShareCards(true)` does for cards.
- Unshared tabs stay purely local: not in the phone's file, so not on the server or other phones,
  and not offloaded (`ServerOffload` already offloads only shared tabs).
- `household_settings` rows of a tab travel only with devices that share that tab (0.9.3 rule,
  `settingTab` in `collect`), and apply only to tabs a device shares. The owner-signed `tabs` row
  is all three in a house (D10), so "what the household shares" no longer limits anything there;
  in phone households it still does, unchanged.
- Server side: entries outside the file's `shares` are dropped before `apply` (and logged: the
  engine's `lastDropped`), records and "moved" deletes alike; a plain delete of a record outside
  `shares` is taken only when that phone made the record (`sync_log.origin`, 0.9.4 final fixes; a
  record whose maker isn't known stays): that's how "Also take what this phone shared off the
  server" works, 14. Other devices pass over a plain delete of a record on a tab they don't sync. A file without `shares` (0.9.3
  phones, browsers) is taken as it is. The server's own file carries every tab; each reader filters
  by its own tabs (existing `apply`).
- Turning a tab off: D11.

## 7. Making a house, and migration

**A fresh 0.9.4 server.** Setup page: first-start password → passphrase (v2 flow, sends `{ salt,
auth }` once, home network only as v2) → **Set up this server**: name. The server makes the
household as `SyncHousehold.create` does (key, `keyv` 1, owner key, `hid`, recovery key, member and
`server` rows, all signed), mode `v3`. Then **Server and phones**.

**Mode on start.** `state.mode` missing: `v2` if any device is registered or any sync file exists,
otherwise `new`. In `v2` the setup page offers no Set up; it says "Hand this household to the
server from the owner phone".

**Handover of a 0.9.3 server household** (one-off, owner phone on 0.9.4, server 0.9.4 in `v2`):
1. The owner phone's server card (shown when `/api/v3/health` says `mode: "v2"` and this phone is
   the owner) offers **Hand this household to the server** and says: sign in on the server's page,
   open Server and phones → Take this household, and scan the code.
2. The web (`POST /api/v3/handover`) shows `restock-handover:3?u=<origin>&t=<token>&k=<kex>`
   (token once, 10 minutes). The phone checks the host is its server's (as for link codes).
3. The phone posts `POST /api/v3/handover/<token>` (signed with its v2 key) `{ epub, sealed }`,
   sealed with HKDF(ECDH(e, server kex), salt token, info "restock-handover-v3"), aad "RSH3":
   `{ format: "restock-handover", v: 3, key (the household key), keyv, serverKeys (its
   server_filekeys and the current one), oldkey?, oldkey_until?, owner_priv, owner_pubkey,
   owner_secrets, secret (its own), recovery?, recovery_saved?, hid, name, ha? }` (`ha`: section 9).
   A phone has no older household keys (only their serverKeys), so neither does the server.
4. The server checks before changing anything: the key opens the owner phone's own sync file, its
   `owner_pub` row matches `owner_pubkey` and verifies, the sender is the household's `owner`.
   Otherwise 409 `handover`, nothing changes.
5. Commit, in this order: (a) `keys.json` written with `handoverPending: true`; (b) `household.db`
   built by reading every sync file and archive (as a new device), then in one transaction the
   signed changes `owner = srv-<sid>`, `member:srv-<sid>`, `server`, handover rows deleted (`tabs` and
   `receipts` stay as the household had them: D10);
   (c) `state.mode = "v3"`, every v2 device kept with `api: 2`; (d) `handoverPending` cleared;
   `restock-sync-srv-<sid>.bin` written; activity moved into `srv_log`. Answer 200.
6. The owner phone stays owner until it reads the server's file with the signed `owner =
   srv-<sid>`. Then 0.9.0's `takeHandover` path ("another phone took over from this one") drops its
   owner secrets, and it upgrades (below). It never drops them on the 200 alone.

Failure and rollback:
- Refused at step 4, or the server stops before (c): on start, `handoverPending` with mode not
  `v3` → `keys.json` handover parts and `household.db` are deleted, mode stays `v2`, logged. The
  phone is still the owner; it can try again.
- Stops after (c), before (d): on start, mode `v3` + pending → finish (d). The phone's retry gets
  409 `done`; it does a round and sees the owner change.
- The 200 is lost: as above.
- Handing back: there is no "undo" button in 0.9.4. If the server is lost or must go, a phone takes
  the household back with the recovery key (D16), which signs a new `owner`. A server that reads a
  validly signed `owner` other than itself stops acting as owner (mode `released`), stops serving
  v3 phones with "Your household was taken back by <phone>", and the web offers to start afresh.

**Widening (D10).** While the household keeps its old `tabs`/`receipts`, the server's own `tabs()` is
narrowed the same way, so it takes in only what the household shares. When the last member that isn't
removed is on v3 (its upgrade, a member join, or the Remove of a phone still on 0.9.3), the server signs
`tabs = "pantry,keg,pharmacy"` and `receipts = "1"`, logs `household-widened`, and reads every file again
for what it passed over. After a bring it also waits until the owner phone's own file is in (that's where
the household's rows come from).

**Phones already on the server** carry on without rescanning: after the handover their v2 requests
are answered 403 `{ error: "update", api: 3, message: "Update Restock to keep syncing with your
server." }`. A 0.9.4 phone seeing `update` with `api: 3` calls `POST /api/v3/upgrade` (signed with
its existing key, so no code), gets its keys and label, switches its paths to `/api/v3`, sets its
sharing to what it shared before (its `tabs`, receipts as the household had them, its cards
choice), and turns folder sync off (D13).

**0.9.3 phones after the handover** get the same 403. 0.9.3's `ServerFolder` shows it as "The
Restock server didn't accept this phone: Update Restock to keep syncing with your server. …" (the
fixed suffix about scanning a new code can't be changed in a released app). It isn't `removed`, so
nothing is forgotten; PollGate backs off to every 30 minutes; the phone works offline. Its file and
archives stay on the server. Wi-Fi sync between 0.9.3 and 0.9.4 phones keeps working (same key,
same SyncWire) until a Remove rekeys; a 0.9.3 phone can't get a v3 rekey and then stays on its own
until updated.

**0.9.3 browsers.** Until the handover the server serves v2 to browsers exactly as now, and the
0.9.4 web build keeps all of v2 (vault, link, webkeys) for `v2` mode. After the handover, a tab
still open on the old build keeps working with its v2 session (v2 session file access stays, and
the server merges a web file whatever the mode); on reload it gets the 0.9.4 build and the v3
sign-in.

**A phone household joining a server (decision 6).** The phone scans a v3 Add a phone code while
in a Wi-Fi or folder household:
- **Server new and empty** (no phone has ever joined and the house has no rows but its record):
  if this phone is the household's **owner**, it offers "Bring <household> onto <server>". The join
  carries the handover payload (step 3) in `bring`; the server checks it (step 4), replaces its
  empty house with this household (keeps the admin's name and signs it), and signs `owner`,
  `server` and the member row for this phone. The other phones see the signed `server` row over
  Wi-Fi or the folder and join through the household (section 4). If this phone **isn't the
  owner**: "Bring your household onto this server from <owner>'s phone, or leave <household> and
  start the server's house with this phone's things."
- **Otherwise:** "This phone will leave <household> and its things will join <server>." The phone
  leaves (`startLeaving`, one last sync if it can, `forget()`; it keeps its things), joins, and
  combines (`yieldToHousehold`: the house's copy wins where both have a record; its other records
  on the tabs it shares go up).
- A phone not in any household joins and its records on shared tabs go up, the same way.
- A 0.9.3 phone scanning a `restock-server:3` code is told it isn't a Restock code (0.9.3 only knows
  `:2`); the server page says "Needs Restock 0.9.4 or newer".
- A 0.9.4 phone on a 0.9.3 server uses v2 as today.

## 8. Retention

The cut-off is `keepCutoff(keepMonths, now)`: `now − keepMonths × 2,629,800,000 ms` (a month is a
year's 365.25 days over 12), as an ISO time, the same arithmetic in Java and Node.

**Keep data for** (3, 6, 9, 12 months, Until I delete; default 12) covers, on the server: prices,
receipts and their photos, `archive/` month files, `srv_log`, and stats (computed from those, so
they follow). Once a day and when the setting changes, with `applying = 1` and no `sync_log`
deletes (D14):
- prices with `date` before the cut-off, except each product's latest (the `pruneHistory` rule);
- receipts with `scanned_at` before the cut-off, unless pinned, their `sync_log` rows, and their
  `photos/` files (to the trash, 30 days, as v2);
- `archive/<device>/<month>.bin` wholly before the cut-off (to the trash);
- `srv_log` lines before the cut-off.
Incoming entries older than the cut-off are passed over (a price only when the server or the same
file has a newer one for that product, so each product's latest stays, as `pruneHistory`), so a
phone's file can't bring them back. The engine's `prune(cutoff)` does the prices and receipts and
returns the receipts that went (their `photo`/`pages`), for the server to trash the photos.
The server's own file no longer lists them, so no phone is told to delete anything; each phone keeps
its own window.

**Phones.** `historyWeeks` (4–52 weeks) is still what each phone keeps. Offload moves prices and
photos older than that **and newer than the server's cut-off** (from the signed `server` row); what's
older than both is tidied on the phone as without a server (it would be pruned at once).
Confirmation before deleting is v2's (listing, read-back, size and version). Until I delete: no
cut-off; `POST /api/v3/prune` deletes older data when the admin asks.

Removed and Left phones' data follows the same window. `sync_log` compaction on the server:
deletes older than 90 days that every **active** phone has seen (`compact` with non-active members
left out); phones compact as today, the server being one of the members whose `seen` counts.

## 9. Home Assistant

**Without a server** (phone households): one phone, the master, syncs the groceries list with Home
Assistant (0.9.3's `ha:phone` row); the others get the list through ordinary household sync. It
lives where it is: Settings → Home Assistant. When it's linked the page says: "This isn't
server-wide. It's just this phone and the phones paired with it." New in 0.9.4:
- Rounds also run in the **background job** (`SyncWorker`, after `syncAll`). The background job
  has no JavaScript, so the round moves to Java: `HaSync.java` and `HaMatch.java`, line-by-line
  ports of `haSync.ts`/`haMatch.ts` (the `Deals.java` ↔ `verdict.ts` precedent), checked on shared
  fixtures. All phone rounds go through Java (one lock, `HomeAssistant.java` keeps the token);
  `homeAssistant.ts` calls `RestockNative.haRound`. `haSync.ts` stays the reference and is what the
  server runs.
- **Deterministic line ids**: a line made from Home Assistant's item gets
  `haLineId(entity, uid) = "ha-" + hex(sha256("restock-ha-v1\n" + entity + "\n" + uid))[0..24]`
  (in `haSync.ts`; `Store.addLine(line, uid)` gets the uid). Adding uses `INSERT OR IGNORE`, then
  pairs with the line already there. Two runners, or a runner and a phone that synced its line,
  can't double an item. Lines from 0.9.3 keep their random `ha-` ids (pairing by words handles them).

**In a house** (D12): `ha:phone` = `srv-<sid>` when the server runs it, and phones never claim it
(`claimHaPhone`/`takeHomeAssistant` refuse when the household's owner is a `srv-` device).
- **The server runs it**: the web's Home Assistant page (address, Test connection, list, token,
  on/off) says when you set it up: "Every phone and browser on this server shares this Home
  Assistant shopping list." The server runs `haSync.syncRound` every 60 seconds and 4 seconds after
  a merge that changed the groceries list, with a `Store` over `household.db` (the Pantry tab's
  lines and items; aliases from `household_settings`; `HA_STATE` in its `kv`) and Node's `fetch`
  as the `Transport` (http only to home or Tailscale addresses, https otherwise, as the phones). Its
  edits go through the triggers as `srv-<sid>`, so they reach phones in its file.
- **A phone's page in a house where the server runs it**: "Home Assistant is handled by your server,
  Declan and Sarah", a link to the server's page, no controls.
- **A house whose server doesn't run it**: recommended (and built): the phone can't do phone-only
  Home Assistant. The page says "In a server household, Home Assistant runs on your server, so every
  phone and browser shares one list" and links to the server's page. Reason: clarity, no second list
  to explain, 24/7, one token.

**Moving Home Assistant to the server at the handover.** The token goes sealed inside a payload,
never in the clear:
- **The HA phone is the owner phone** (it must be 0.9.4 to hand over): the handover payload carries
  `ha: { address, entity, enabled, token, state }` (`token` read by Java from its key store for this
  one purpose; `state` = its `HA_STATE`, so the server carries on with the same pairs and nothing
  is re-paired). The server stores it in `keys.json`, signs `ha:phone = srv-<sid>`, and starts.
  The phone deletes its token and turns Home Assistant off once it reads that row.
- **The HA phone is another 0.9.4 phone**: its `POST /api/v3/upgrade` carries the same `ha`
  payload, sealed to the server's kex key (same HKDF as join, info "restock-ha-v3"), taken only if
  the server isn't running Home Assistant yet.
- **The HA phone is still on 0.9.3**: it can't send anything new and, paused, won't read the
  server's file. The web shows "Home Assistant still runs on <phone> (Restock 0.9.3). Update
  Restock on it to move Home Assistant here, or turn Home Assistant off on it and set it up here."
  The server won't run Home Assistant while `ha:phone` names a phone with `api: 2` until the admin
  ticks "It's off on <phone>". (Both running would only double until word-pairing catches up, but
  the safe default is one runner.)
- A household with no HA phone: set up on the web as above.

## 10. Offline guarantees (the phone never depends on the server)

Every phone keeps a full working copy of what it shares plus its history window. Without the server,
or with bad reception in a shop: the list opens at once from the local database; ticking, adding
pantry or typed items, editing quantities, pantry and receipts all work; every change is in
`sync_log` and goes up at the next round. The phone never waits for the server: rounds run in the
background (`SyncWorker`, the 60-second poll, after edits) and failures only set `serverError` and
back off. Only searching shops needs the internet. Never on the server's path: opening Restock, the
list, price alerts and notifications (computed on the phone), backups, Wi-Fi sync. Offload deletes
a local copy only after the server confirms it (v2 rule), and a phone with an expired or missing
server keeps everything it has. Keys live on the phone, so a server that's down or gone never locks
a phone out of its own data.

## 11. Privacy and security

**Readable where, in a house:**
- On each phone: everything it has, as today.
- On the server: everything phones share (Pantry and list, Keg and Pharmacy if shared, receipts and
  photos if shared, prices including years of offloaded history), the household record, the phones'
  summaries, the Home Assistant token, activity and logs. Loyalty card numbers are blanked before
  they reach `household.db`, but a phone that shares cards puts them in its sealed file, which the
  server can open. Anyone with a copy of the data volume can read all of this.
- In transit: sealed (phones always; browsers too, with the active-attacker limit for plain http).
- In a downloaded backup: encrypted with the backup passphrase.
- Never on the server: anything a phone doesn't share, the passphrase, phone private keys.

**Threat model in plain words.** Whoever runs the server, or gets its disk or an unencrypted copy of
its data folder, can read the household's shared things. Someone on your Wi-Fi can't read or change
phone traffic, even over plain http, and can't sign in by watching a browser sign in (they could try
to guess the passphrase offline, which the 600,000-round key and the passphrase rules make slow).
Someone who can change traffic on your network can tamper with the web page over plain http (use
https or Tailscale for the browser). A removed or stolen phone loses access as soon as it's removed
and can't read anything changed after that. The makers of Restock still never see anything.

**`PRIVACY.md` changes** (the "From 0.9.2" server paragraphs and the summary at the top):
- The server can now read what phones share with it, to merge it, keep history and stats, run Home
  Assistant and show the web app; it says what it keeps and for how long (Keep data for).
- Each phone chooses what it shares (defaults as section 6); unshared tabs never leave the phone.
- The Home Assistant token moves to the server when Home Assistant runs there.
- Phone traffic is sealed and signed; browser sign-in no longer sends a reusable key; backups are
  encrypted; data at rest on the server isn't, so recommend an encrypted disk.
- Removing a phone stops its syncing and changes the household's key; what it shared stays.
- Drop "The server can't open any of it" and the vault/link paragraph for houses; keep them for
  0.9.3-style servers (v2 mode) and phone households.
- The phone summary is now readable by the server (it was sealed from it).
- `server/README.md` "What the server can and can't see" and "What's in the data volume" change to
  match.

## 12. Work packages

Package 1 goes first (about a day: formats and the core). Then 2, 3, 4 and 5 in parallel; each owns
its files, and the formats above are the only contract between them. Shared test vectors
(`tools/sync-test/vectors-v3.json`: RSJ3, RSE3, RSH3, session key and MAC, `haLineId`) are written in
package 1 and read by every package's tests.

**P1, core and formats (Restock repo).** Owns: `src/server-core/index.ts` (new),
`vite.core.config.ts` (new), `package.json` script `build:server-core`, `src/server-mode/engine.ts`
(role option, `writeHousehold`, `shares`, `ownerOnly` + `server`), `src/server-mode/crypto.ts`
(RSJ3/RSE3/RSH3, session key, request MAC, challenge proof), `src/lib/haSync.ts` (`haLineId`,
`Store.addLine(line, uid)`), `src/lib/sql/schema.ts` only if a server table must live there (it
shouldn't), `docs/server-protocol.md` (v3 section moved in from here), `tools/sync-test/vectors-v3.json`.
Tests: vitest for the engine role on node:sqlite and the crypto vectors (`src/server-core/core.test.ts`,
kept apart from `serverMode.test.ts` so P5 can change that file freely), `haLineId` and two runners
(`haSync.test.ts`); the build emits one file with no imports but `node:*` (in fact none); `web-parity`
still green.

**P2, the server (server repo).** Owns: `src/server.mjs` (mode, routing), new `src/v3/house.mjs`
(household record, signing, join, upgrade, handover, rekey), `src/v3/merge.mjs` (node:sqlite adapter,
merge queue, own file, retention), `src/v3/webauth.mjs` (challenge login, sessions, MAC, sealing),
`src/v3/ha.mjs`, `src/v3/backup.mjs` (tar + gzip + scrypt/AES-GCM, `scripts/restore.mjs`),
`src/names.mjs`, `src/state.mjs`, `public/setup/*` (Set up this server), `scripts/core.mjs`,
`Dockerfile`, `compose.yaml`, `restock/*`, `README.md`, `package.json`.
Tests (node:test, with `test/client.mjs` growing a v3 phone and v3 browser): v2 suite unchanged and
green in v2 mode; fresh setup → join → merge → own file; member join; Remove → rekey and `keys/`
read rules; Leave; per-phone `shares` filtering; retention (prices, receipts, archives, logs, no
deletes in the server's file); handover happy path and every crash point (`RESTOCK_TEST_CRASH=
after-keys|after-db|after-mode`), wrong key, wrong owner, replayed token; v2 phone gets `update`
after handover; old v2 session still reads files; login challenge, MAC, replay, Sign out
everywhere; backup round trip; Home Assistant against a pretend Home Assistant (no doubles with
deterministic ids, token never in any answer or log); Node version check.

**P3, phones' sync (Java and the phone's sync screens).** Owns: `ServerSync.java`,
`ServerFolder.java`, `ServerLink.java`, `ServerOffload.java`, `SyncFolder.java`, `SyncHousehold.java`,
`SyncEngine.java` (`shareReceipts`), `SyncHub.java`, `SharedSettings.java` (seed rule),
`PhoneSummary.java`, `RestockNativePlugin.java` (sync calls only), `src/lib/sync.ts`,
`src/lib/sql/native.ts` (sync calls), `src/ui/screens/RestockServer.tsx`, `Sync.tsx`,
`Household.tsx`.
Tests (`tools/sync-test`, new `SyncServerV3Test.java` against the real server built by P2): join with
label and shares defaults; member join; rekey via `keys/`; removed phone; Leave; what-this-phone-shares
both directions; Wi-Fi between two v3 phones after a rekey; offload with `keepMonths`; folder sync
off in a house; handover from a 0.9.3 owner phone; **old phones** (`v093` tag compiled like
`OldReader`): a 0.9.3 phone paused with the update words and nothing forgotten, still Wi-Fi syncing
with a 0.9.4 phone; a Wi-Fi household brought onto a new server; a phone leaving its household to
join a server (combine).

**P4, Home Assistant on the phone.** Owns: new `HaSync.java`, `HaMatch.java`, `HomeAssistant.java`,
`SyncWorker.java`, `RestockNativePlugin.java` (HA calls only), `src/lib/homeAssistant.ts`,
`src/lib/listPicks.ts`, `src/ui/screens/HomeAssistant.tsx`.
Tests: shared fixtures run through `haSync.ts` (vitest) and `HaSync.java` with identical results
(merge, safety catch, deterministic ids); background round with the lock; the page's three states
(phone household, house with server HA, house without); refusing to claim `ha:phone` in a house;
token handed over only inside the sealed payload.

**P5, the web app (Restock repo, server mode).** Owns: `src/server-mode/session.ts`, `api.ts`,
`live.ts`, `round.ts` (skip archives in v3; history comes from the API), `main.tsx`, `flag.ts`,
`src/server-mode/ui/*` (Server and phones, Browsers, Activity and logs, Settings with Keep data for,
passphrase, backup, recovery key, Home Assistant page, Take this household code, Set up flow),
`tools/sync-test/server-web.mjs`.
Tests: `serverMode.test.ts` and `live.test.ts` for v3 login, MAC, sealed answers and the round;
v2 mode still works against a v2 server (the 0.9.3 browser flows); `web-parity` unchanged.

Overlaps resolved: `RestockNativePlugin.java` is split by section (P3 sync methods, P4 HA methods);
`engine.ts` and `crypto.ts` change only in P1; P2 consumes the core build, never edits Restock files.

## 13. Open questions for Declan

- **Q1. "Pantry and Shopping list": one switch or two?** This design reads it as one switch, the
  groceries tab (pantry with its list), because that's the unit sync already has. Two separate
  switches (share the list but not the pantry) is a new kind of split in the engine and would add
  a few days. Default if no answer: one switch.
- **Q2. Turning a tab off later: keep or take back?** This design keeps what was already shared on
  the server (D11), like Remove. The alternative, "Also take what I shared off the server", is
  possible but deletes it for everyone. For Keg and Pharmacy the privacy reading might favour
  taking it back. Default if no answer: keep, and the sheet says so.

## 14. Answers (decided 10 Nov 2026, from Declan's brief)

- **Q1:** one switch, "Groceries (pantry and shopping list)", on by default.
- **Q2:** keep by default. When a phone turns off Keg, Pharmacy, Receipts or Loyalty cards, the sheet also offers an unticked "Also take what this phone shared off the server". Ticked, the server deletes that phone's shared rows for that tab (other people's rows stay), and the phone sends deletes for them. Removing a phone never deletes anything.
  - How (P1): the phone's deletes do it. The server takes a delete of a record outside the phone's `shares` only when that phone made it (`sync_log.origin`; final fixes: not "was the last to change it", which took other people's things) (section 6), and passes the delete on in its own file; phones that don't share the tab pass it over. P3: the phone must send those deletes as plain (not `moved`) deletes in its file, for the records of that tab it made, and for receipts and cards too, which `collect` otherwise leaves out once they aren't shared.
  - Final fixes (Declan): the turn-off and Leave sheets always say that the prices and product details found at the shops stay on the server for the household (they're about the shops, not the person), and that personal things stay unless taken back. Leaving offers the same take-back boxes for each personal kind the phone shares, unticked, with Select all.
- **Receipts default:** OFF for a phone joining a server house (Declan: not everyone wants to share receipts). Phone-made households keep their current behaviour.
- **Home Assistant in a server house when the server doesn't run it:** phones can't run their own (D13 as written). Their page says to set it up on the server's page.

## 15. Also in 0.9.4 (from Declan's testing; packages named)

- **P3, phone screens:**
  - sync and backups redesign as on the "Restock sync redesign" canvas: server first, then Wi-Fi, then a cloud drive folder with examples (Google Drive, Dropbox, OneDrive, Syncthing, Nextcloud, WebDAV);
  - the strip shows only channels in use, with "Last backup" plus day and time;
  - Sync now says what it did and never mentions Wi-Fi phones unless Wi-Fi sync is on;
  - Add a phone and Leave sheets as on the canvas;
  - the local-first line on Setup's first screen: "Works without signal. Your list and pantry live on your phone. Only searching shops needs internet."
- **P3, specials:** phones share the specials and catalogue data they fetched, sealed like everything else, as a device-file section the server keeps (never fetched by the server: no scraping).
- **P5, web:**
  - clicking a list line opens the product; only the checkbox ticks;
  - product thumbnails in the pantry table, side panel and full item page;
  - Which branch: a household default branch per chain, editable on the web, used by phones that haven't picked their own;
  - Sign out and Sync now always in the sidebar foot; each sign-out and backup option explained;
  - Specials and catalogues: every followed shop with its website, specials and catalogue links, like the phone, plus This week's specials and My catalogue on Home, from what phones shared;
  - Settings: Keep data for 3, 6, 9 or 12 months, or Until I delete.
