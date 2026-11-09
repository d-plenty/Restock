# Restock server protocol (v2, Restock 0.9.2)

The contract between the server (`server/`), the phones (Java, `ServerFolder.java` and friends) and the
web app (the Restock web build running in a browser, served by the server). Three people build these at
once: change this file only when you must, keep the change small, and list it under "Changes" at the end.

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
prices"). Loyalty cards show greyed out with the shop's name and "Kept on your phones for privacy"; their
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
