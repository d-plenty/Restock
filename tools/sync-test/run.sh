#!/bin/bash
# The Java sync check (0.9.0, 0.9.1): the recovery key, folder and WebDAV sync, receipts and their
# photos, tidying old deletes and sealed secrets, run on a computer against real SQLite databases
# (through Python's sqlite3) with Restock's own layout. Needs Java 17+, Python 3 and org.json on
# the classpath (ORGJSON=/path/to/json.jar or a folder of its classes). Other plain-Java classes the
# sync code uses (Net, and what it uses) are found through -sourcepath.
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

bash tools/sync-test/web-parity.sh

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
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null; rm -rf "$D"' EXIT
for i in $(seq 100); do curl -sf http://127.0.0.1:$PORT/api/v2/health >/dev/null && break; sleep 0.1; done
curl -sf http://127.0.0.1:$PORT/api/v2/health >/dev/null || { echo "The Restock server didn't start:"; cat "$D/server.log"; exit 1; }
node tools/sync-test/server-web.mjs setup http://127.0.0.1:$PORT "$D/browser.json" >/dev/null
java -cp "$O/classes:$ORGJSON" family.plenty.restock.SyncServerTest "$O" http://127.0.0.1:$PORT "$D/browser.json" "$D/data"
