# Restock on iPhone (test build)

Restock has an iPhone app. It is **not on the App Store or TestFlight yet**, so for now it is
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
> - **It's a test build.** Things will be missing or broken. The list is below.

## What you need

- An iPhone on **iOS 15 or later**.
- A Windows 10 or 11 PC, or a Mac.
- Your Apple Account (the free kind is fine).
- The file **`restock-<version>-unsigned.ipa`** from the newest release on
  [the Restock releases page](https://github.com/d-plenty/Restock/releases), under Assets.

## Installing with Sideloadly (Windows or Mac)

1. On Windows, install **iTunes from Apple's website** (not the Microsoft Store one), open it, plug
   the iPhone in and tap **Trust** on the phone.
2. Install **Sideloadly** from sideloadly.io and open it.
3. Drag the `.ipa` file onto Sideloadly, pick your iPhone, type your Apple Account email, and press **Start**.
   It asks for your Apple Account password and a sign-in code.
4. On the iPhone: **Settings → General → VPN & Device Management**, tap your Apple Account, then **Trust**.
5. On iOS 16 or later: **Settings → Privacy & Security → Developer Mode**, turn it on. The phone restarts.
6. Open Restock.

To renew after 7 days, or to install a newer version: plug in and do step 3 again with the same
Apple Account. Don't delete Restock from the phone first.

## What's different from Android

| | On iPhone |
|---|---|
| **Your pantry, tabs, shopping list, inventory, cards, receipts** | The same. Everything is kept on the iPhone. |
| **Searching the shops, adding items** | The same, for shops that answer a plain request. |
| **Barcode scanner, notifications, backups** | Work. Backups go to **Files → On My iPhone → Restock → Restock backups**. |
| **Price checks** | **When you open Restock**, if the last check is more than 12 hours old, and when you tap Check now. An iPhone doesn't let an app run at a set time like 4 am. Each product is found again by searching its shop for its name, which is a little slower than Android's direct check. |
| **Updates** | Greyed out. Apple doesn't let an app update itself. Install the newer `.ipa` the same way. |
| **Sharing with a household (Wi-Fi), a Restock server, a cloud folder** | **Not yet.** Greyed out, with the reason. The server is next. |
| **Home Assistant** | Not yet. |
| **Shared price history** (judging a new item from day one) | Not yet. Restock builds each item's history from its own checks on the iPhone. |
| **A shop's own page inside Restock** (signing in to Woolworths, Coles or Costco, picking a Coles branch, Unblock) | **Not yet.** A shop that wants you to pass its "are you a person" check can't be unblocked on iPhone for now. |
| **Home screen widgets, changing the app icon** | Not yet. |
| **Price helper phone** | Android only. |
| **Deal and catalogue-day notifications from a background check** | Only after a check that ran while Restock was open. |

Anything that can't be done on an iPhone stays on the screen, greyed out, with **Why is this greyed
out?** under it.

## Building it yourself

The iPhone app is built by GitHub: **Actions → iPhone app → Run workflow**
(`.github/workflows/ios.yml`). It needs no Apple account and makes the unsigned `.ipa`. With a Mac
and Xcode 26 or later: `npm ci && npm run build && npx cap sync ios`, then open
`ios/App/App.xcodeproj`.
