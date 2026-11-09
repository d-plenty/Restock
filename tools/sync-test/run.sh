#!/bin/bash
# The Java sync check (0.9.0, 0.9.1): the recovery key, folder and WebDAV sync, receipts and their
# photos, tidying old deletes and sealed secrets, run on a computer against real SQLite databases
# (through Python's sqlite3) with Restock's own layout. Needs Java 17+, Python 3 and org.json on
# the classpath (ORGJSON=/path/to/json.jar or a folder of its classes). Other plain-Java classes the
# sync code uses (Net, and what it uses) are found through -sourcepath.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/run.sh

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
