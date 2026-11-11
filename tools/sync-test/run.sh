#!/bin/bash
# The Java sync check (0.9.0, 0.9.1): the recovery key, folder and WebDAV sync, receipts and their
# photos, tidying old deletes and sealed secrets, run on a computer against real SQLite databases
# (through Python's sqlite3) with Restock's own layout. Needs Java 17+, Python 3 and org.json on
# the classpath (ORGJSON=/path/to/json.jar or a folder of its classes). Other plain-Java classes the
# sync code uses (Net, and what it uses) are found through -sourcepath.
# 0.9.3: household settings (SyncTest093), and phones on 0.9.0–0.9.2 reading a 0.9.3 phone's file
# (tools/sync-test/old, compiled against each version's code from the repo's tags).
# 0.9.2: then phones and a real Restock server (github.com/d-plenty/restock-server cloned next to
# this repo, or RESTOCK_SERVER_DIR; needs Node 22+, no npm install there).
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/run.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
npx vitest run --config tools/sync-test/vitest.config.ts >/dev/null
J=android/app/src/main/java/family/plenty/restock
O=tools/sync-test/out
rm -rf $O/classes && mkdir -p $O/classes
cp tools/sync-test/bridge.py $O/
javac -nowarn -d $O/classes -cp "$ORGJSON" -sourcepath android/app/src/main/java tools/sync-test/family/plenty/restock/*.java $J/SyncEngine.java $J/SyncHousehold.java $J/SyncWire.java $J/SyncFolder.java $J/SyncDav.java $J/Shops.java $J/Net.java
java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncTest090 "$O"
java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncFamily "$O"
java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncTest091 "$O"
# 0.9.3: household-wide settings and the phone's summary for the web.
java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncTest093 "$O"

# 0.9.3: phones still on 0.9.0, 0.9.1 and 0.9.2 (their own sync code and database layout, from the
# repo's tags) read a 0.9.3 phone's file: the new data is passed over, the rest comes in as before.
for tag in base090 base091 v092; do
  if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
    echo "Old phone check for $tag skipped: no such tag here."
    continue
  fi
  OS=$O/old-$tag
  rm -rf $OS/src $OS/classes && mkdir -p $OS/src $OS/classes
  git archive "$tag" android/app/src/main/java | tar -x -C $OS/src
  cp tools/sync-test/bridge.py $OS/
  javac -nowarn -d $OS/classes -cp "$ORGJSON" -sourcepath $OS/src/android/app/src/main/java tools/sync-test/old/OldReader.java tools/sync-test/family/plenty/restock/TestDb.java
  java -cp "$OS/classes:$ORGJSON" family.plenty.restock.OldReader "$OS" "$O/old-reader" "$tag"
done

# 0.9.5: the General list, between 0.9.5 phones and with a phone still on 0.9.4 (its own sync code,
# from the v094 tag, on a database file the test then opens with this version's code: the update).
OLD094=""
if git rev-parse -q --verify "refs/tags/v094" >/dev/null 2>&1; then
  OS=$O/old-v094
  rm -rf $OS && mkdir -p $OS/src $OS/classes
  git archive v094 android/app/src/main/java | tar -x -C $OS/src
  cp tools/sync-test/bridge.py $O/migrations.json $OS/
  javac -nowarn -d $OS/classes -cp "$ORGJSON" -sourcepath $OS/src/android/app/src/main/java tools/sync-test/old/OldPhone094.java tools/sync-test/family/plenty/restock/TestDb.java
  OLD094="$OS/classes:$ORGJSON;$(cd $OS && pwd)"
fi
RESTOCK_OLD094="$OLD094" java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncTest095 "$O"
# 0.9.6: "Move to" another list (moveLine.ts), on the Wi-Fi and through a shared folder.
java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncTest096 "$O"
# 0.9.6: Wi-Fi sync is its own feature, off in a server's house unless set up (an earlier real use is kept).
java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncWifiTest096 "$O"
# 0.9.6 (review H1, L2): Costco and the shared shopping list and items.

bash tools/sync-test/web-parity.sh
# 0.9.4: Home Assistant's round in Java (HaSync.java) against haSync.ts, on shared fixtures.
bash tools/sync-test/ha-parity.sh

# 0.9.2: phones syncing through a real Restock server, with a stand-in browser (server-web.mjs)
# that opens what the phones seal with the web app's own code. The server lives in its own repo
# (github.com/d-plenty/restock-server): clone it next to this one, or set RESTOCK_SERVER_DIR.
SERVER_DIR=${RESTOCK_SERVER_DIR:-}
[ -z "$SERVER_DIR" ] && for d in server ../restock-server; do [ -f "$d/src/server.mjs" ] && SERVER_DIR=$d && break; done
if [ -z "$SERVER_DIR" ]; then
  echo "Restock server scenarios skipped: clone github.com/d-plenty/restock-server next to this repo (or set RESTOCK_SERVER_DIR) to run them."
  exit 0
fi
export RESTOCK_SERVER_DIR=$(cd "$SERVER_DIR" && pwd)
D=$(mktemp -d)
mkdir -p "$D/data"
PORT=${RESTOCK_TEST_PORT:-18787}
(cd "$SERVER_DIR" && DATA_DIR="$D/data" PORT=$PORT HOST=127.0.0.1 RESTOCK_QUIET=1 exec node src/server.mjs >"$D/server.log" 2>&1) &
SERVER=$!
V3PIDS=""
trap 'kill $SERVER $V3PIDS 2>/dev/null; wait $SERVER $V3PIDS 2>/dev/null; rm -rf "$D"' EXIT
for i in $(seq 100); do curl -sf http://127.0.0.1:$PORT/api/v2/health >/dev/null && break; sleep 0.1; done
curl -sf http://127.0.0.1:$PORT/api/v2/health >/dev/null || { echo "The Restock server didn't start:"; cat "$D/server.log"; exit 1; }
node tools/sync-test/server-web.mjs setup http://127.0.0.1:$PORT "$D/browser.json" >/dev/null
java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncServerTest "$O" http://127.0.0.1:$PORT "$D/browser.json" "$D/data"

# 0.9.4: protocol v3, where the server is the household's owner (docs/server-v3-design.md), once the
# server has it: three fresh servers (one made a house, one left in v2 mode for the handover, one a
# Wi-Fi household is brought onto), with the server repo's test clients as the web page.
if grep -qs "/api/v3/" "$SERVER_DIR"/src/v3/*.mjs; then
  [ -f "$SERVER_DIR/core/restock-core.mjs" ] || (cd "$SERVER_DIR" && RESTOCK_DIR="$(cd - >/dev/null && pwd)" node scripts/core.mjs >/dev/null)
  URLS=()
  for k in 1 2 3; do
    P3PORT=$((PORT + k))
    mkdir -p "$D/v3-$k"
    (cd "$SERVER_DIR" && DATA_DIR="$D/v3-$k" PORT=$P3PORT HOST=127.0.0.1 RESTOCK_QUIET=1 exec node --disable-warning=ExperimentalWarning src/server.mjs >"$D/v3-$k.log" 2>&1) &
    V3PIDS="$V3PIDS $!"
    URLS+=("http://127.0.0.1:$P3PORT")
  done
  for u in "${URLS[@]}"; do
    for i in $(seq 100); do curl -sf "$u/api/v3/health" >/dev/null && break; sleep 0.1; done
    curl -sf "$u/api/v3/health" >/dev/null || { echo "A v3 Restock server didn't start:"; cat "$D"/v3-*.log; exit 1; }
  done
  mkdir -p "$D/v3state"
  # A phone still on 0.9.3 (its own sync code, from the v093 tag) takes part in the handover.
  OLD093=""
  if git rev-parse -q --verify "refs/tags/v093" >/dev/null 2>&1; then
    OS=$O/old-v093
    rm -rf $OS && mkdir -p $OS/src $OS/classes
    git archive v093 android/app/src/main/java | tar -x -C $OS/src
    cp tools/sync-test/bridge.py $O/migrations.json $OS/
    javac -nowarn -d $OS/classes -cp "$ORGJSON" -sourcepath $OS/src/android/app/src/main/java tools/sync-test/old/OldServerPhone.java tools/sync-test/family/plenty/restock/TestDb.java
    OLD093="$OS/classes:$ORGJSON;$OS"
  else
    echo "Old phone checks for 0.9.3 on a v3 server skipped: no v093 tag here."
  fi
  RESTOCK_OLD093="$OLD093" RESTOCK_OLD094="$OLD094" java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncServerV3Test "$O" "${URLS[@]}" "$D/v3state"
else
  echo "Restock server v3 scenarios skipped: this server has no /api/v3 yet."
fi
