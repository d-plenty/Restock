# Building Restock

This builds the Restock APK from the terminal. You don't need Android Studio. Steps 1–4 are a one-off setup (about 20 minutes); after that, building again takes about a minute.

You'll end up with `app-release.apk`, which installs on any Android 8.0 or newer phone, including de-Googled ones.

- [Linux](#1-install-nodejs-and-java-21) (Fedora, Ubuntu, Debian and friends): the main path, every step below
- [macOS](#macos)
- [Windows](#windows)
- [Building again](#building-again), [Testing](#testing-your-changes), [The Restock server's web app](#the-restock-servers-web-app-and-core), [Signing](#signing), [Troubleshooting](#if-something-goes-wrong)

---

## 1. Install Node.js and Java 21

**Node.js 22 or newer:**

```bash
# Fedora
sudo dnf install -y nodejs git unzip
# Ubuntu / Debian (Node 22 from NodeSource, since the distro one is often older)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git unzip
```

Check: `node --version` must say **v22** or newer.

**Java 21, exactly.** The Android build tools need Java 21; newer versions (like Fedora's Java 25) won't work. These commands put a separate copy of Java 21 (Eclipse Temurin, open source) in `~/Android/jdk`, so your system Java is left alone and no root is needed:

```bash
mkdir -p ~/Android/jdk ~/Downloads
curl -L -o ~/Downloads/temurin-21.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
curl -s "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=linux&vendor=eclipse" | python3 -c "import sys, json; print(json.load(sys.stdin)[0]['binary']['package']['checksum'] + '  ' + sys.argv[1])" ~/Downloads/temurin-21.tar.gz | sha256sum -c
```

The last command must print `OK`. If it doesn't, stop: the download is damaged.

```bash
tar -xzf ~/Downloads/temurin-21.tar.gz -C ~/Android/jdk --strip-components=1
~/Android/jdk/bin/java -version
```

It must say **21**. On an ARM computer, change `x64` to `aarch64` in both links.

## 2. Get Google's Android command-line tools

```bash
mkdir -p ~/Android/Sdk/cmdline-tools
cd ~/Downloads
curl -LO https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip
echo "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583  commandlinetools-linux-15859902_latest.zip" | sha256sum -c
```

It must print `OK`. Then:

```bash
unzip -q commandlinetools-linux-15859902_latest.zip -d ~/Android/Sdk/cmdline-tools
mv ~/Android/Sdk/cmdline-tools/cmdline-tools ~/Android/Sdk/cmdline-tools/latest
```

## 3. Point your shell at Java and the Android tools

```bash
cat >> ~/.bashrc <<'EOF'

# Android builds (Restock)
export ANDROID_HOME="$HOME/Android/Sdk"
export JAVA_HOME="$HOME/Android/jdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
EOF
source ~/.bashrc
sdkmanager --version
```

(Using zsh? Put the same lines in `~/.zshrc`.)

## 4. Install the Android platform pieces

```bash
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

## 5. Get the code

```bash
cd ~
git clone https://github.com/d-plenty/Restock.git restock
cd ~/restock
npm ci
```

Optional, run the tests (they should all pass):

```bash
npm test
```

## 6. Build the APK

```bash
cd ~/restock
chmod +x android/gradlew
npm run android:apk
```

The first build downloads Gradle and the Android libraries, so give it 5–10 minutes. It should finish with **BUILD SUCCESSFUL**. The APK is at:

```
~/restock/android/app/build/outputs/apk/release/app-release.apk
```

## 7. Put it on your phone

**Without a cable:** send `app-release.apk` to your phone (LocalSend, Nextcloud, email, anything), tap it, allow the install when Android asks, and tap **Install**.

**With a USB cable:** turn on Settings → System → Developer options → USB debugging on the phone, plug it in, and run:

```bash
adb install -r ~/restock/android/app/build/outputs/apk/release/app-release.apk
```

> **Already have the official Restock installed?** Your build is signed with your own computer's key, so Android won't install it over the official one (or the other way round). Export a backup in Settings first, uninstall, install yours, and restore.

---

## macOS

Install [Homebrew](https://brew.sh) if you haven't, then:

```bash
brew install node git
brew install --cask temurin@21 android-commandlinetools
cat >> ~/.zshrc <<'EOF'

# Android builds (Restock)
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
EOF
source ~/.zshrc
```

Then do steps 4 to 7 above as written.

## Windows

The easiest way is **WSL** (Windows Subsystem for Linux). In PowerShell as administrator:

```powershell
wsl --install -d Ubuntu
```

Restart, open **Ubuntu** from the Start menu, and follow the Linux steps from step 1 (the Ubuntu lines). When the APK is built, copy it to Windows to send it to your phone:

```bash
cp ~/restock/android/app/build/outputs/apk/release/app-release.apk /mnt/c/Users/Public/
```

---

## Building again

```bash
cd ~/restock
git pull
npm ci
npm run android:apk
```

Installing over the top keeps your data. To test setup like a brand-new user, uninstall first:

```bash
adb uninstall family.plenty.restock
adb install ~/restock/android/app/build/outputs/apk/release/app-release.apk
```

## Testing your changes

Before you send a pull request:

```bash
npm run typecheck
npm test
```

**Try it in a desktop browser.** `npm run dev` runs the app at `http://localhost:5173`. The shops can't be reached from a browser (they need the phone), so for clicking through screens use made-up shops instead:

```bash
VITE_FAKE_STORES=1 npm run dev
```

**On the phone**, build a debug APK first (`npm run android:apk-debug`, which lands in `android/app/build/outputs/apk/debug/app-debug.apk`; release builds can't be inspected). It installs as a separate app (`family.plenty.restock.debug`, with its own data), so it never replaces the real Restock. Then, plug it in with USB debugging on, open `chrome://inspect` in Chrome or Chromium on your computer and click **inspect** under Restock: the Console shows errors from the app. Background checks log with:

```bash
adb logcat -s RestockCheck
```

Tapping **Check now** in the app runs exactly the same code as the background check, so it's the quickest way to test it.

## The Restock server's web app and core

The [Restock server](https://github.com/d-plenty/restock-server) runs two things built from this repo: the web app (also what goes on an iPhone's home screen) and the core (the merge engine, Home Assistant's sync and the shop search). You only need these if you work on the server or build its image yourself; its Docker build makes them on its own.

```bash
cd ~/restock
git clone https://github.com/d-plenty/restock-server.git server   # once: the server's code, inside this checkout
npm run build:server-web     # the web app, into server/public/app/
npm run build:server-core    # the core, into server/core/restock-core.mjs
cd server && npm test        # the server's tests, with that core
```

The server needs Node 22.13 or newer. How to run it is in [its README](https://github.com/d-plenty/restock-server#readme).

## Signing

`npm run android:apk` makes a release build. Without a key of your own, it's signed with your computer's own debug key (the build prints a warning), which is fine for testing but won't install over the official Restock. If you want builds that install over each other from any computer, `android/app/build.gradle` uses a key in `~/.restock/signing.properties` when it finds one. How to make one is in [docs/RELEASING.md](docs/RELEASING.md). **Never commit a key**; `*.keystore` is in `.gitignore`.

If you publish your own version of Restock, please also change `applicationId` in `android/app/build.gradle` and give it your own name and icon, so it installs alongside the official app instead of clashing with it.

## If something goes wrong

- **`SDK location not found`**: run `source ~/.bashrc` (or `~/.zshrc`) and try again.
- **`Unsupported class file major version`**: the build isn't using Java 21. Run `echo $JAVA_HOME`; it should end in `Android/jdk` (Linux) or a `temurin-21` folder (macOS).
- **The build fails on a licence**: run `yes | sdkmanager --licenses` again.
- **`npm ci` fails**: check `node --version` is 22 or newer.
- **Still stuck?** [Open an issue](../../issues/new/choose) with your operating system and the last 30 lines of the error.
