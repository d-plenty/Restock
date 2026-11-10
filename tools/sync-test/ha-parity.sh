#!/bin/bash
# 0.9.4: Home Assistant's round in Java (HaSync.java, HaMatch.java) against haSync.ts: the shared
# fixtures (tools/sync-test/ha-fixtures.json, whose answers src/lib/haParity.test.ts checks on the
# TypeScript side), the v3 vectors, and the round on Restock's real database layout (HaSyncTest.java).
# Needs Java 17+, Python 3 and org.json, as run.sh does.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/ha-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
npx vitest run --config tools/sync-test/vitest.config.ts tools/sync-test/schema.test.ts >/dev/null
npx vitest run src/lib/haParity.test.ts >/dev/null
J=android/app/src/main/java/family/plenty/restock
T=tools/sync-test/family/plenty/restock
O=tools/sync-test/out
rm -rf $O/ha-classes && mkdir -p $O/ha-classes
cp tools/sync-test/bridge.py $O/
javac -nowarn -d $O/ha-classes -cp "$ORGJSON" -sourcepath android/app/src/main/java $T/HaSyncTest.java $T/TestDb.java $J/HaSync.java $J/HaMatch.java
java -cp "$O/ha-classes:$ORGJSON" family.plenty.restock.HaSyncTest "$O"
