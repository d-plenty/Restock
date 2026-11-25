#!/bin/bash
# The iPhone's recall check (src/ios/recalls.ts) against the Android app's own Recalls.java, on the
# same pages and names (recalls/fixtures.json): both must read and match them the same way.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/recalls-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
O=tools/sync-test/out
rm -rf $O/recall-classes && mkdir -p $O/recall-classes
javac -nowarn -d $O/recall-classes -cp "$ORGJSON" tools/sync-test/family/plenty/restock/RecallsDump.java android/app/src/main/java/family/plenty/restock/Recalls.java
java -cp "$O/recall-classes:$ORGJSON" family.plenty.restock.RecallsDump tools/sync-test/recalls/fixtures.json > $O/recalls-java.json
RECALLS_JAVA="$O/recalls-java.json" npx vitest run --config tools/sync-test/vitest.config.ts tools/sync-test/recalls-parity.test.ts
