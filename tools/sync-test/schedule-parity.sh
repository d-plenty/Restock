#!/bin/bash
# 0.9.6: price checks at a set time of day. CheckSchedule.java against the shared answers
# (tools/sync-test/schedule-fixtures.json), which src/lib/checkSchedule096.test.ts checks on the
# TypeScript side. Needs Java 17+ and org.json, as run.sh does.
# Run from the repo root:  ORGJSON=~/json-20240303.jar bash tools/sync-test/schedule-parity.sh

set -e
cd "$(dirname "$0")/../.."
: "${ORGJSON:?Set ORGJSON to the org.json jar (https://github.com/stleary/JSON-java)}"
npx vitest run src/lib/checkSchedule096.test.ts >/dev/null
J=android/app/src/main/java/family/plenty/restock
O=tools/sync-test/out
rm -rf $O/schedule-classes && mkdir -p $O/schedule-classes
javac -nowarn -d $O/schedule-classes -cp "$ORGJSON" tools/sync-test/family/plenty/restock/CheckScheduleTest096.java $J/CheckSchedule.java
java -cp "$O/schedule-classes:$ORGJSON" family.plenty.restock.CheckScheduleTest096 tools/sync-test/schedule-fixtures.json
