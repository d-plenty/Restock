# Restock on Google Play and the App Store

Restock isn't on either store yet. Since 0.15.1, the versions they'd take are built with every
release and attached to it **unsigned**, so they're ready when the accounts are. This page covers:

- what each store needs
- what's already been changed for them
- what's left to do, in order
- drafts of the forms each store asks you to fill in

The APK on GitHub and in Restock's own F-Droid repo stays as it is. It's the full version: it updates
itself, and it's the one to use if you don't want a store.

Checked in November 2026. Store rules change, so look again before you submit. The sources are at
the end.

## The versions

| Version | Where it comes from | Updates | How it's built |
| --- | --- | --- | --- |
| **APK** (`github`) | GitHub Releases, Restock's own F-Droid repo, Obtainium | Restock checks and installs them itself (you tap Install), or F-Droid does | `npm run android:apk` → `android/app/build/outputs/apk/github/release/app-github-release.apk` |
| **Google Play** (`play`) | Not published yet | Google Play | `npm run android:play` → `android/app/build/outputs/bundle/playRelease/app-play-release.aab`; unsigned on each release as `restock-<version>-play-unsigned.aab` |
| **iPhone from a computer** (`sideload`) | GitHub Releases (`restock-<version>-unsigned.ipa`) | Install the new one from your computer | `ios.yml` |
| **App Store and TestFlight** (`appstore`) | Not published yet | The App Store | `stores.yml`: `restock-<version>-appstore-unsigned.xcarchive.zip` on each release |

The web part of the app is the same in all of them. Each one finds out which version it is when it
starts (Android: `BuildConfig.CHANNEL`; iPhone: `RestockChannel` in `Info.plist`) and leaves out what
doesn't belong in that version.

## Google Play

### Already done (0.15.1)

- **No self-updating.** The Play version has no Check for updates and no "Tell me when there's an
  update". It also doesn't have the `REQUEST_INSTALL_PACKAGES` permission: its own manifest
  (`android/app/src/play/AndroidManifest.xml`) removes it. Play only allows that permission for apps
  whose main job is installing apps. The native updater refuses too, in case the web part ever asked.
- **No "always run in the background" question.** `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is removed
  from the Play version. Play only allows it for a few kinds of app. Instead, the background setting
  opens Android's battery list, where you find Restock and choose "Don't optimise".
- **Nothing about other app stores.** No link to Restock's F-Droid repo, and Coming soon doesn't list
  F-Droid.
- **Targets Android 16 (API 36).** That's what Play needs from 31 August 2026.
- **16 KB memory pages.** Nothing to do: Restock has no native libraries of its own.
- **No Google Play services, no Firebase, no ads, no tracking.** Nothing from Google is added.

### Still to do, in order

1. **A Google Play developer account.** It costs a one-off fee and needs Google's identity checks.
2. **Closed testing first.** A personal account made after 13 November 2023 needs **at least 12
   testers in a closed test, each opted in for 14 days in a row**, before it can apply for production
   access. Google then usually reviews within seven days. Family and friends with Android phones count.
3. **App signing.** Play App Signing holds the key that signs what people install. You upload with an
   upload key, which can be the key that signs the GitHub APK (`~/.restock/signing.properties`) or a
   new one. Never put it in the repository. One thing to know: the Play version and the APK share an
   app ID, so a phone can't have both. Changing from one to the other means uninstalling first, and
   because they're signed differently, Android won't treat one as an update of the other.
4. **Foreground services.** Play Console asks why the app uses each kind:
   - `connectedDevice`: Ready to sync, which keeps Restock listening for the household's phones on
     the Wi-Fi. It's off unless turned on, and it shows a notification.
   - `dataSync`: the shop search test in Diagnostics, only while one you started is running.

   Play asks for a short video of each.
5. **Fill in the forms** (drafts below): the Data safety form, the content rating questionnaire, the
   target audience (not for children), the privacy policy address, and the store listing (text,
   icon, screenshots, feature graphic).
6. **Before you submit, decide:**
   - **Costco.** It stays off by default in every version. Decide whether the Play version offers it
     at all.
   - **Reading shop websites.** Restock reads the shops' public websites the way a browser does. Play
     has no rule against that, but a shop could complain to Google. Be ready to explain what Restock
     does: it reads prices for one person or household, at the rate a person would.

### Android developer verification (it affects the APK too)

Google is bringing in developer verification for apps installed on certified Android phones, from
any source, not just Play:

- It started in Brazil, Indonesia, Singapore and Thailand on **30 September 2026**.
- It goes worldwide **from 2027**.
- A developer verifies their identity once and registers their apps. The Android Developer Console
  does this for apps outside Play; Play Console registers Play apps itself.
- Without it, Restock's APK will still install, but only through Android's "advanced flow" (for
  people who know what they're doing) or a computer (ADB).
- There's a free limited distribution account for students and hobbyists: no ID, up to 20 devices.

**Worth doing before 2027**, so the APK keeps installing normally.

## The App Store and TestFlight

### Already done (0.15.1)

- **Nothing about installing from a computer.** The App Store version's Coming soon doesn't say
  "installed from a computer", and has no link to the sideloading guide. Nothing else in the app
  mentions sideloading.
- **No self-updating.** The iPhone app never had it.
- **A privacy manifest** (`ios/App/App/PrivacyInfo.xcprivacy`):
  - no tracking, and no data collected by the developer
  - the one "required reason" thing it does is read file times: in the folder the household shares
    (reason 3B52.1) and in its own files (C617.1)
  - Capacitor's own manifests cover what Capacitor does
- **Encryption.** `ITSAppUsesNonExemptEncryption` is already `false` in `Info.plist`. Restock encrypts
  the household's files with standard methods (AES, elliptic-curve keys), for the user's own data.
  Check that this counts as exempt for you: Apple's questions about it, and the US export rules
  behind them, are a legal matter.
- **No sign-in to anything of the developer's, no ads, no tracking, no in-app purchases.**

### Still to do, in order

1. **An Apple Developer Program membership:** US$99 a year, charged in Australian dollars at sign-up.
2. **Sign and upload:**
   - Download `restock-<version>-appstore-unsigned.xcarchive.zip` from a release and open it in
     Xcode's Organizer.
   - Distribute App → App Store Connect: Xcode signs it with your account as it uploads.
   - If Organizer won't take an unsigned archive, archive it yourself on a Mac. Run `npm run build`
     and `npx cap sync ios`, add `RestockChannel` = `appstore` to `Info.plist`, then Product → Archive.
3. **TestFlight.** The same upload is the TestFlight build:
   - Internal testers (up to 100 people on your App Store Connect team) can test straight away.
   - External testers need Apple's beta review first.
4. **App Store Connect forms** (drafts below): App Privacy, the age rating, the category (Shopping or
   Lifestyle), the privacy policy address, and the description, keywords and screenshots.
5. **Review notes.** Things Apple's reviewers will ask about, to explain up front:
   - **Plain http.** Since 0.15.2 the App Store version only allows it on the home network
     (`NSAllowsLocalNetworking`: IP addresses and `.local` names), to reach the user's own Restock
     server or Home Assistant at an address they typed. A name like `nas.lan` needs https there. The
     version installed from a computer still allows any address (`NSAllowsArbitraryLoads`).
   - **Local network.** It's for Wi-Fi sync with the household's phones, and iOS asks the user first.
   - **Shop websites.** Restock opens the shops' own public pages to read prices, like a browser.
   - **A demo.** Reviewers need to try it without a household: an empty Home's "Look around with sample
     items" does that.
6. **Decide Costco** (as for Play).

## Drafts for the forms

### Store listing

- **Name:** Restock
- **Short description (Play, 80 characters):** "Your pantry, shopping list and the prices at your shops, kept on your phone."
- **Description:** "Restock keeps your pantry and shopping list, and the prices at the
  supermarkets you use, on your phone. It tells you when something you buy is a good price, what's
  on special, and which shop is cheapest for your list. Share it with your household through iCloud
  Drive, your own Wi-Fi or your own Restock server: no account, nothing kept by anyone else. Free,
  open source, no ads."
  Check that every word is still true when you submit, and leave out anything that isn't in that
  version yet.

### Google Play: Data safety

The questions are about what the app sends off the phone to the developer or to others.

- **Does the app collect or share user data?** Restock sends nothing to its developer. It sends:
  - to the shops: what you search for and the products whose prices it checks, as a browser would
  - to your household's own folder or your own server: your household's data, sealed
  - to Open Food Facts: a barcode, when you look one up

  It's worth reading Google's definitions closely here. Data sent to a service the user chooses, as
  part of what they asked for, may not count as "collected". Be honest whichever way you answer.
- **Is data encrypted in transit?** Yes (https). A household's files are also sealed, so the folder
  or server only holds a jumble.
- **Can users ask for their data to be deleted?** It's all on the phone: Settings → Advanced →
  Erase everything. On a Restock server, its Delete.

### App Store: App Privacy

- **Data used to track you:** none.
- **Data linked to you / not linked to you:** answer as for Play. If the answer is that the developer
  collects nothing, it's "Data Not Collected".

### Privacy policy

Both stores need a privacy policy at a web address. Since 0.15.2 it's
[docs/PRIVACY.md](PRIVACY.md) (and the fine print, [docs/TERMS.md](TERMS.md)): the same words the app
shows, made from them by `node tools/legal-pages/make.mjs` (a test fails if they drift apart). Its
address is `https://github.com/d-plenty/Restock/blob/main/docs/PRIVACY.md`.

## Sources

- Google Play: [testing requirements for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
- Google Play: [REQUEST_INSTALL_PACKAGES policy](https://support.google.com/googleplay/android-developer/answer/12085295)
- Google Play: [target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- Android Developers Blog: [Android developer verification rolling out to all developers](https://android-developers.googleblog.com/2026/03/android-developer-verification-rolling-out-to-all-developers.html)
- Apple: [membership fee](https://developer.apple.com/support/purchase-activation)
- Apple: [privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)
