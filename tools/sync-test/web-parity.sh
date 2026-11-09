#!/bin/bash
# 0.9.2: the web app's sync merge against the phones' Java code, both ways (web-parity.test.ts,
# SyncWebParity.java). Needs Java 17+, Python 3 and org.json, as run.sh does.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/web-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
npx vitest run --config tools/sync-test/vitest.config.ts tools/sync-test/schema.test.ts >/dev/null
J=android/app/src/main/java/family/plenty/restock
T=tools/sync-test/family/plenty/restock
O=tools/sync-test/out
rm -rf $O/web-classes && mkdir -p $O/web-classes
cp tools/sync-test/bridge.py $O/
javac -nowarn -d $O/web-classes -cp "$ORGJSON" -sourcepath android/app/src/main/java \
  $T/SyncWebParity.java $T/SyncFamily.java $T/TestDb.java $J/SyncEngine.java $J/SyncHousehold.java $J/SyncWire.java $J/SyncFolder.java $J/Shops.java $J/Net.java
PARITY_CP="$O/web-classes:$ORGJSON" npx vitest run --config tools/sync-test/vitest.config.ts tools/sync-test/web-parity.test.ts
