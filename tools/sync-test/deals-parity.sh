#!/bin/bash
# 0.9.6: Deals.java against the shared answers (tools/sync-test/deals-fixtures-096.json) that
# src/lib/dealsParity096.test.ts checks on the TypeScript side. Needs Java 17+ and org.json.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/deals-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
npx vitest run src/lib/dealsParity096.test.ts >/dev/null
J=android/app/src/main/java/family/plenty/restock
O=$(mktemp -d)
trap 'rm -rf "$O"' EXIT
javac -nowarn -d "$O" -cp "$ORGJSON" tools/sync-test/family/plenty/restock/DealsTest096.java $J/Deals.java
java -cp "$O:$ORGJSON" family.plenty.restock.DealsTest096 tools/sync-test/deals-fixtures-096.json
