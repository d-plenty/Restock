# Restock on iPhone and iPad

Restock has an app for iPhone and iPad (one app for both). It is **not on the App Store or TestFlight yet**, so for now it is
installed from a computer, the way a developer would. This page says how, and what is different
from the Android app.

> **Read this first**
>
> - **You need a computer** (Windows or Mac) and a cable. It can't be installed from the iPhone alone.
> - **It stops opening after 7 days.** A free Apple Account can only sign an app for a week. Plug
>   the phone in and install it again to keep going. Your data stays, as long as you install over
>   the top and don't delete the app first.
> - **Back up first, and often** (Settings → Sync and backups → Backups). If the app is deleted, or
>   signing goes wrong, the backup file is the only copy of your pantry.
> - **This is unofficial.** Apple doesn't support installing apps this way, and the tools that do it
>   are made by other people, not by Restock or Apple. You sign in to them with your Apple Account;
>   use an app-specific password or a spare Apple Account if that worries you.
> - **A free Apple Account can have 3 apps installed this way at once**, and can make 10 new ones a week.
> - **It hasn't had as much testing as the Android app.** Parts of it were first run on a real iPhone only at release. Tell us what breaks.

## What you need

- An iPhone or iPad on **iOS or iPadOS 15 or later**.
- A Windows 10 or 11 PC, or a Mac.
- Your Apple Account (the free kind is fine).
- The file **`restock-<version>-unsigned.ipa`** from the newest release on
  [the Restock releases page](https://github.com/d-plenty/Restock/releases), under Assets.

## Installing with Sideloadly (Windows or Mac)

1. On Windows, install **iTunes** and **iCloud** from Apple's website (the installers, not the
   Microsoft Store apps). Sideloadly's own page links to both.
2. Install **Sideloadly** from sideloadly.io and open it.
3. Plug the iPhone in with a cable that carries data, unlock it, and tap **Trust** on the phone.
4. Drag the `.ipa` file onto Sideloadly. Your iPhone should be named in the **iDevice** box. Type your
   Apple Account email, and press **Start**. It asks for your Apple Account password and a sign-in code.
5. On the iPhone: **Settings → General → VPN & Device Management**, tap your Apple Account, then **Trust**.
6. On iOS 16 or later: **Settings → Privacy & Security → Developer Mode**, turn it on. The phone restarts.
7. Open Restock.

To renew after 7 days, or to install a newer version: plug in and do step 4 again with the same
Apple Account. Don't delete Restock from the phone first.

### If Windows gets in the way

- **iCloud's installer says "missing Media features"** (a fresh Windows 11 can have them off). Right-click
  Start, choose **Terminal (Admin)**, and run these two, then restart the PC:

  ```
  DISM /Online /Enable-Feature /FeatureName:MediaPlayback /All /NoRestart
  DISM /Online /Add-Capability /CapabilityName:Media.WindowsMediaPlayer~~~~0.0.12.0
  ```

- **Sideloadly says "no devices detected"** although File Explorer shows the iPhone. Windows is using
  its camera driver for the phone and doesn't have Apple's yet. With the phone plugged in and unlocked,
  open **Settings → Windows Update → Advanced options → Optional updates → Driver updates**, tick the
  lines that start with **Apple**, and install them. Unplug the phone, plug it back in, and press the
  refresh button in Sideloadly.

## What's different from Android

| | On iPhone and iPad |
|---|---|
| **Your pantry, tabs, shopping list, inventory, cards, receipts** | The same. Everything is kept on the device. |
| **Searching the shops, adding items** | The same. Restock asks each shop from inside the shop's own page in a hidden browser, as on Android. |
| **A shop's own page inside Restock** (signing in to Woolworths, Coles or Costco, picking a Coles branch, Unblock) | Works, including recording a trolley (in Diagnostics). |
| **Barcode scanner, notifications** | Work. |
| **Backups** | Work. Automatic backups are made **when you open Restock** and the last one is old enough, and go to **Files → On My iPhone → Restock → Restock backups**. There is no folder to pick. |
| **Export data and Import data** | The same as Android: save to a file or send straight to another phone with a QR code; import from a file, a scanned code or a photo of the code, adding alongside or replacing. A file is saved or picked through the Files app. |
| **Cards** | The same, including expiry dates on loyalty cards with a reminder a month before. |
| **Price checks** | **When you open Restock**, if the last check is more than 12 hours old, and when you tap Check now. Picking a time of day isn't possible on iPhone due to Apple's restrictions. Each product is found again by searching its shop for its name, which is a little slower than Android's direct check. |
| **Sync** | **While Restock is open.** It syncs when it opens or comes back, every minute after that, and a few seconds after you change something. iOS also wakes Restock now and then for a short sync while it's closed (Background App Refresh), when it chooses to: not if the app was swiped away, and not in Low Power Mode. Don't count on that. |
| **Your Restock server** | Works, for a server that is the house (Restock server 0.9.4 or later, set up as the house). Scan its Add a phone code. Receipts and loyalty cards are shared when you turn them on, and Sign in on a computer works by scanning the page's code. Turning something off stops sharing it from then on; an iPhone doesn't offer to also take what it shared back off the server. Old prices aren't moved to the server: the phone keeps its own history and the server has what was synced. |
| **Sync with an Android phone over Wi-Fi** | Works. Either phone can start the household; the other joins with its code. The Android phone answers in the background. The iPhone listens and looks for the other phones **only while Restock is open on it**, on the same Wi-Fi. The first time, iOS asks whether Restock may find devices on your local network: say yes. Receipts, their photos and loyalty cards are shared when turned on. The phone that started a household can't hand that job to another phone from an iPhone; it leaves once the others have. |
| **iPhone to iPhone over Wi-Fi** | Works, under Advanced, and isn't recommended: it only swaps changes while **both** have Restock open on screen at the same moment. For a household of iPhones, iCloud sync is the way. |
| **iCloud sync** (a shared folder in iCloud Drive) | Works, and is the recommended way for a household of iPhones and iPads to share. No server and no account with Restock. See below. |
| **Home Assistant** | Works while Restock is open (a voice add shows up a moment after you open Restock, not within 15 minutes with it closed). The token is kept in the app's own storage. |
| **Updates** | Not possible on iPhone due to Apple's restrictions: an app can't update itself. Install the newer `.ipa` the same way. |
| **Shared price history** (judging a new item from day one) and **sending prices back** | Works, with the same rules as Android. The history downloads after a price check when there's something new (on Wi-Fi unless you allow mobile data). |
| **Recall alerts** | Works. Android checks once a day in the background; an iPhone or iPad checks when you open Restock, at most once a day, and from Check now. |
| **The database** | A real SQLite file in the app's own storage (`Application Support/Restock/restock.sqlite`), part of the device's backups. It runs in memory while Restock is open and is written out after each change and when the app goes to the background; a save that fails is shown on Home and in Diagnostics. |
| **Changing the app icon's colour** | Works: the same 16 colours. iOS shows its own "You have changed the icon" message each time. |
| **Home screen widgets** | Not yet: coming. The row is in Settings, greyed. |
| **Price helper phone** | Android only. |
| **Deal and catalogue-day notifications from a background check** | Only after a check that ran while Restock was open. |
| **iPad** | Held sideways, the tabs are down the left side with Your shops, Receipts, Cards and Settings under them. Held upright it's the iPhone layout. |

Anything that can't be done stays on the screen, greyed out, in a box with **Why is this unavailable?** along its bottom edge.

### iCloud sync

For a household of iPhones and iPads. Everyone shares one folder in iCloud Drive; each device puts
its changes there when Restock is open and picks up everyone else's. Nobody needs to have Restock
open at the same time.

1. On the household's first device, in the **Files** app, make a folder in **iCloud Drive** (call it
   Restock), press and hold it, tap **Share**, then **Collaborate**, and invite the others by their
   Apple Account. Leave them able to make changes.
2. On each of their devices, accept the invitation.
3. On the first device, in Restock: **Settings → Sync and backups → iCloud sync**, **Pick the
   folder**, then **Start a household here**.
4. On each other device: the same screen, **Pick the folder** (the same one), then **Join with a
   code**. On the first device tap **Add an iPhone or iPad** and scan the code it shows. Keep Restock
   open on both until it says the device is in. iCloud can take a minute to pass things along.

Good to know:

- **What's shared:** pantry, shopping lists, inventory, the tabs you made, household settings and
  recent prices. Receipts and loyalty cards stay on each device.
- **What's in the folder is sealed** with a key only your household's devices hold. Apple, and anyone
  else the folder is shared with, see files they can't read.
- **The first device is the one that adds and takes out others.** Taking a device out stops it
  sharing; also stop sharing the iCloud folder with that person in Files, which is what shuts them
  out of the folder.
- **An Android phone can't join an iCloud folder.** A household with Android phones in it shares
  through a Restock server.
- **A device is in one household at a time:** a Restock server's house or an iCloud household.
- It has been tested with a pretend folder, not yet between two real iPhones. Keep a backup.

### Plain http and your own network

Restock on iPhone may talk to addresses on your own network over plain http (a Restock server or a
Home Assistant at home), so iOS asks once for permission to find devices on your local network. Say
yes if you use either. Away from home, use an https address, as on Android.

## Building it yourself

The iPhone app is built by GitHub: **Actions → iPhone app → Run workflow**
(`.github/workflows/ios.yml`). It needs no Apple account and makes the unsigned `.ipa`. With a Mac
and Xcode 26 or later: `npm ci && npm run build && npx cap sync ios`, then open
`ios/App/App.xcodeproj`.
