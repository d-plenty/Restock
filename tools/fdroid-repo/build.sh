#!/usr/bin/env bash
# Builds Restock's own F-Droid repository from release APKs, ready to publish on GitHub Pages.
# Run by .github/workflows/fdroid-repo.yml after each release; it can be run by hand too.
#
# Needs (environment):
#   FDROID_KEYSTORE      the repo's signing keystore (PKCS12), base64
#   FDROID_KEYSTORE_PASS its password
#   APK_DIR              folder with the APKs to list (one per version)
#   SITE_DIR             where to write the website (index.html, repo/)
#   REPO_URL             the repo's address, e.g. https://d-plenty.github.io/Restock/repo
#   APP_ID               optional, default family.plenty.restock
#
# Needs fdroidserver (pip install fdroidserver segno) and Java (keytool).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_ID="${APP_ID:-family.plenty.restock}"
ALIAS="restockrepo"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

mkdir -p repo metadata "metadata/$APP_ID"
cp "$APK_DIR"/*.apk repo/
# fdroid copies this into repo/icons/ itself.
cp "$ROOT/docs/icon-512.png" icon.png
cp "$ROOT/tools/fdroid-repo/app.yml" "metadata/$APP_ID.yml"
# Store listing: the same text, screenshots and changelogs as the main F-Droid recipe.
cp -r "$ROOT/fastlane/metadata/android/en-US" "metadata/$APP_ID/en-US"

printf '%s' "$FDROID_KEYSTORE" | base64 -d > keystore.p12
umask 077
cat > config.yml <<EOF
repo_url: $REPO_URL
repo_name: Restock
repo_description: >-
  Restock's own F-Droid repository, straight from its GitHub releases: the same APKs, signed
  with the same key. Restock is a free, open-source Australian grocery price tracker.
repo_icon: icon.png
archive_older: 0
keystore: keystore.p12
repo_keyalias: $ALIAS
keystorepass: "$FDROID_KEYSTORE_PASS"
keypass: "$FDROID_KEYSTORE_PASS"
keydname: CN=Restock F-Droid repo, O=D Plenty, C=AU
EOF
# apksigner comes from the Android SDK (GitHub's runners have one) or from PATH.
if [ -n "${ANDROID_HOME:-}" ]; then echo "sdk_path: $ANDROID_HOME" >> config.yml; fi

fdroid update --pretty --use-date-from-apk

FINGERPRINT="$(keytool -list -v -keystore keystore.p12 -storetype PKCS12 -storepass "$FDROID_KEYSTORE_PASS" -alias "$ALIAS" 2>/dev/null \
  | sed -n 's/.*SHA256: *//p' | head -1 | tr -d ': ' | tr 'A-F' 'a-f')"
if [ -z "$FINGERPRINT" ]; then
  echo "Couldn't read the repo key's fingerprint" >&2
  exit 1
fi

mkdir -p "$SITE_DIR"
cp -r repo "$SITE_DIR/repo"
ADD_URL="$REPO_URL?fingerprint=$FINGERPRINT"
APP_URL="fdroidrepos://${REPO_URL#https://}?fingerprint=$FINGERPRINT"
python3 - "$SITE_DIR" "$ADD_URL" "$APP_URL" "$FINGERPRINT" "$ROOT" <<'PY'
import html, sys
import segno
site, add_url, app_url, fp, root = sys.argv[1:]
segno.make(add_url, error='m').save(f'{site}/repo-qr.svg', scale=8, border=4)
fp_spaced = ' '.join(fp[i:i + 4] for i in range(0, len(fp), 4))
page = open(f'{root}/tools/fdroid-repo/index.html').read()
for k, v in {'ADD_URL': add_url, 'APP_URL': app_url, 'FINGERPRINT': fp_spaced}.items():
    page = page.replace('{{' + k + '}}', html.escape(v))
open(f'{site}/index.html', 'w').write(page)
PY
cp "$ROOT/docs/icon-512.png" "$SITE_DIR/icon.png"
echo "F-Droid repo ready in $SITE_DIR"
echo "Add it with: $ADD_URL"
