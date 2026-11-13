#!/bin/bash
# 0.10.3: Deals.java's Always on special against the shared answers (tools/sync-test/always-fixtures-0103.json)
# that src/lib/always0103.test.ts checks on the TypeScript side. Needs Java 17+ and org.json.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/always-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
npx vitest run src/lib/always0103.test.ts >/dev/null
J=android/app/src/main/java/family/plenty/restock
O=$(mktemp -d)
trap 'rm -rf "$O"' EXIT
javac -nowarn -d "$O" -cp "$ORGJSON" tools/sync-test/family/plenty/restock/AlwaysTest0103.java $J/Deals.java
java -cp "$O:$ORGJSON" family.plenty.restock.AlwaysTest0103 tools/sync-test/always-fixtures-0103.json
