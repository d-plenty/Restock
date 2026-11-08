# Releasing Restock

For the maintainer. This is how an official Restock APK is made, signed and published, so anyone who installs it from Releases (or through Obtainium) gets updates that install over the top.

## The signing key (once, ever)

Android only installs an update over the top if it's signed with the same key as the version on the phone. Official releases are signed with Restock's own key, kept outside the project in `~/.restock`. `android/app/build.gradle` uses it automatically when it's there.

```bash
mkdir -p ~/.restock
chmod 700 ~/.restock
PASS=$(openssl rand -base64 24 | tr -d '/+=')
"$JAVA_HOME/bin/keytool" -genkeypair -v -keystore ~/.restock/restock-release.keystore -alias restock -keyalg RSA -keysize 4096 -validity 36500 -storepass "$PASS" -keypass "$PASS" -dname "CN=Restock, O=Plenty Technologies, C=AU"
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=restock\nkeyPassword=%s\n' "$HOME/.restock/restock-release.keystore" "$PASS" "$PASS" > ~/.restock/signing.properties
chmod 600 ~/.restock/signing.properties
unset PASS
```

**Back it up off the computer** (USB stick, password manager). If it's lost, nobody can ever update over the top again, and every user has to uninstall. If it's leaked, someone could publish a fake update, so never put it in the repo, a chat or an issue.

```bash
tar czf ~/restock-signing-key-backup.tar.gz -C ~ .restock
```

## Each release

1. **Bump the version** in all of these (versionCode goes up by one every release, and never goes down):
   - `package.json` → `"version"`
   - `package-lock.json` → the two `"version"` lines at the top (lines 3 and 9)
   - `android/app/build.gradle` → `versionCode` and `versionName`
   - `README.md` → the beta badge
   - `.github/ISSUE_TEMPLATE/*.yml` → the version placeholder
2. **Check it:**
   ```bash
   cd ~/restock
   npm ci
   npm run typecheck
   npm test
   ```
3. **Build:**
   ```bash
   npm run android:apk
   cp android/app/build/outputs/apk/debug/app-debug.apk ~/restock-$(node -p "require('./package.json').version").apk
   ```
4. **Install it on your own phone over the last release** and give it a quick go. Installing over the top proves the signing key matches.
5. **Commit and tag:**
   ```bash
   VERSION=$(node -p "require('./package.json').version")
   git add -A
   git commit -m "Restock $VERSION"
   git tag "v$VERSION"
   git push
   git push --tags
   ```
6. **Publish on GitHub:** Releases → **Draft a new release** → choose the tag → title `Restock 0.x.y` → write what's new in plain words → drag in the APK, plus a copy of it named `restock.apk` (the README's download link always points at that name in the latest release) → **Publish release**.
7. **Add the checksum** to the release notes so people can check their download:
   ```bash
   sha256sum ~/restock-$VERSION.apk
   ```

Obtainium picks up new releases from the Releases page automatically.

**Restock's own F-Droid repo** (https://d-plenty.github.io/Restock/) updates itself too: publishing a release starts the *F-Droid repo* action (`.github/workflows/fdroid-repo.yml`), which takes the APKs from the last 5 releases, builds the repo with `tools/fdroid-repo/build.sh` and puts it on GitHub Pages. It can also be run by hand from the Actions tab. It signs the repo's index with its own key (not the app's), kept in `~/.restock/fdroid-repo.p12` and in the repo's `FDROID_KEYSTORE` and `FDROID_KEYSTORE_PASS` secrets. Back that key up with the rest of `~/.restock`: if it changes, everyone who added the repo has to remove it and add it again. Name the APK the same way every time (`restock-0.x.y.apk`).

## Before 1.0

- Ask the shops and data sources for permission before anything like shared prices goes public.
- F-Droid needs builds it can reproduce from the source; check their inclusion policy when it's time.
