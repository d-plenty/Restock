#!/bin/bash
# 0.10.2: Aisles.java against the shared answers (tools/sync-test/aisle-fixtures-0102.json) that
# src/lib/aisles0102.test.ts checks on the TypeScript side. Needs Java 17+ and org.json.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/aisle-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
npx vitest run src/lib/aisles0102.test.ts >/dev/null
J=android/app/src/main/java/family/plenty/restock
O=$(mktemp -d)
trap 'rm -rf "$O"' EXIT
javac -nowarn -d "$O" -cp "$ORGJSON" tools/sync-test/family/plenty/restock/AislesTest0102.java $J/Aisles.java
java -cp "$O:$ORGJSON" family.plenty.restock.AislesTest0102 tools/sync-test/aisle-fixtures-0102.json
