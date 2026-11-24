#!/bin/bash
# 0.14.0: the iPhone's phone-to-phone sync (src/ios/wire.ts) against the Android app's own Java code
# over real sockets (wire-parity.test.ts, WirePeer.java). Needs Java 17+, Python 3 and org.json.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/wire-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
npx vitest run --config tools/sync-test/vitest.config.ts tools/sync-test/schema.test.ts >/dev/null
J=android/app/src/main/java/family/plenty/restock
T=tools/sync-test/family/plenty/restock
O=tools/sync-test/out
rm -rf $O/wire-classes && mkdir -p $O/wire-classes
cp tools/sync-test/bridge.py $O/
javac -nowarn -d $O/wire-classes -cp "$ORGJSON" -sourcepath android/app/src/main/java \
  $T/WirePeer.java $T/SyncFamily.java $T/TestDb.java $J/SyncEngine.java $J/SyncHousehold.java $J/SyncWire.java $J/SyncFolder.java $J/Shops.java $J/Net.java
PARITY_CP="$O/wire-classes:$ORGJSON" PARITY_OUT="$O" npx vitest run --config tools/sync-test/vitest.config.ts tools/sync-test/wire-parity.test.ts
