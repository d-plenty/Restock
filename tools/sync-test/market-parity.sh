#!/bin/bash
# The iPhone's shared-history summary (src/ios/market.ts) against the Android app's own
# Deals.summarise, on 600 made-up price histories: every number must come out the same.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/market-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
O=tools/sync-test/out
rm -rf $O/market-classes && mkdir -p $O/market-classes
javac -nowarn -d $O/market-classes -cp "$ORGJSON" tools/sync-test/family/plenty/restock/MarketDump.java android/app/src/main/java/family/plenty/restock/Deals.java
java -cp "$O/market-classes:$ORGJSON" family.plenty.restock.MarketDump > $O/market-java.json
MARKET_JAVA="$O/market-java.json" npx vitest run --config tools/sync-test/vitest.config.ts tools/sync-test/market-parity.test.ts
