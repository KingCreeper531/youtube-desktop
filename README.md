# YouTube Desktop

An unofficial app for [YouTube] on Windows, Android and iPhone(https://www.youtube.com), part of the Ranch apps. Install and update it yourself, or through the [Ranch Launcher](https://github.com/KingCreeper531/ranch-launcher).

## Features

- **No ads.** Video ads are removed from the player's data before they can play, and anything that slips through is skipped. Ad and tracker requests are blocked (EasyList and EasyPrivacy), and sponsored cards are hidden from the feed, search and sidebar.
- **SponsorBlock.** Skips sponsors, self-promotion and subscribe reminders (pick more categories in settings). Skipped parts show as coloured marks on the progress bar, and every skip has an **Undo** button. The app only sends the server the first characters of a hash of the video ID, so it never learns what you watch.
- **Dislike counts.** Shows dislike numbers from [Return YouTube Dislike](https://returnyoutubedislike.com), plus a like ratio bar.
- **Picture in picture.** A button in the player (or **Ctrl+Shift+P**) pops the video out into a small window that stays on top.
- **Quality of life.**
  - Pick a video quality for every video.
  - The app remembers your playback speed.
  - Theater mode by default.
  - End-screen cards can be hidden.
  - No "Continue watching?" pauses, and playback keeps going when the window is minimized.
  - Shorts can be hidden, or opened in the normal player.
  - Copied links have the `si=` tracking code removed.
- **Discord status.** Shows "Watching" with the video, channel, thumbnail, a progress bar and a "Watch on YouTube" button. When paused, it shows "(Paused)".
- **Easy settings.** Click the gear button in the top bar (or press **Ctrl+,**). The Ranch Launcher can change the same settings.
- **Auto-update.** A green **Update** button appears in the top bar when a new release is out.

## Download

Get the latest release from the [Releases page](https://github.com/KingCreeper531/youtube-desktop/releases/latest):

- `YouTube-Setup-x.y.z.exe`: installer (recommended). It updates itself.
- `YouTube-Portable-x.y.z.exe`: runs without installing.
- `YouTube-Android-x.y.z.apk`: Android app (Android 8 or newer) with ad blocking, SponsorBlock, dislike counts and background play. Open it on your phone to install.
- `YouTube-iOS-x.y.z.ipa`: iPhone and iPad app. It's unsigned, so install it with [AltStore](https://altstore.io) or [Sideloadly](https://sideloadly.io) using your Apple ID.

Windows SmartScreen may warn about the app because it isn't code-signed. Click **More info**, then **Run anyway**.

## Signing in

Google blocks password sign-in inside apps like this one. Sign in to youtube.com in Firefox first, then choose **Sign in with Firefox** (in settings, or from the tray icon). Your Firefox sign-in is copied into the app and never leaves your PC.

## Build it yourself

```
npm install
npm start          # run it
npm run dist       # build the installer into dist/
npm run release    # build and publish a GitHub release (needs the GitHub CLI)
```