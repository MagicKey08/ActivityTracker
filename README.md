# ActivityTracker

A Vencord userplugin that tracks voice time, activities, messages, status, profile changes and typing for the users you choose, and shows it all in an interactive dashboard with a heatmap, voice-time-by-server and a full timeline. Everything stays local on your machine.

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Vencord userplugin](https://img.shields.io/badge/Vencord-userplugin-5865F2.svg)](https://docs.vencord.dev/installing/custom-plugins/)

## Features

- **Voice session tracking**: join / leave / move events paired into sessions with duration, server and channel (ongoing sessions show a LIVE badge)
- **Activity tracking**: games, Spotify, streaming, rich presence
- **Status changes**: online / idle / dnd / offline
- **Profile changes**: avatar, banner, username, display name, bio, pronouns, custom status (shown as before -> after)
- **Message logging** (optional, off by default): the first 200 characters, with channel and server
- **Typing** (optional, off by default)
- **Interactive dashboard**: profile card with live presence, stat strip, voice-time-by-server bars, a week-by-week activity heatmap with voice sessions drawn in, and a merged timeline. Filter by type, search by name/ID, export JSON.
- **Local file storage**: logs are stored per user as JSON files in your Vencord data folder (`ActivityTrackerData`), not crammed into `settings.json`. Configurable retention in days.

## Usage

- Right-click a user -> **Start Tracking User**
- Right-click a user -> **Activity Tracker** to open the dashboard
- Console helpers: `Vencord.Plugins.plugins.ActivityTracker.openDashboard()`, `.trackUser("ID")`, `.untrackUser("ID")`, `.getActivityLogs()`

Nobody is tracked by default. You add people yourself.

## Settings

- Log messages (off by default), profile changes (on by default) and typing (off by default)
- Notifications for status, voice, profile, typing (all off by default)
- History retention in days (default 30, `0` keeps everything)

## Installation

This is a Vencord **userplugin**, so it is not in the official plugin list. You need a [source build of Vencord](https://docs.vencord.dev/installing/).

1. Clone this repo into your Vencord userplugins folder:
   ```sh
   cd Vencord/src/userplugins
   git clone https://github.com/MagicKey08/ActivityTracker
   ```
2. Build Vencord from the `Vencord` folder:
   ```sh
   pnpm build
   ```
3. Close Discord fully, then inject:
   ```sh
   pnpm inject
   ```
4. Start Discord and enable **ActivityTracker** under Settings -> Vencord -> Plugins.

## Privacy and responsible use

- All logs stay local in your Vencord data folder. Nothing is sent anywhere.
- Only track people who know about it and are fine with it. Do not use this to stalk or harass anyone, or in any way that breaks your server's rules.

## Compatibility

Tested on Windows with a Vencord source build in the Discord desktop app (stable), October 2026.

Discord updates can break plugin patches at any time. If something stops working, please [open an issue](https://github.com/MagicKey08/ActivityTracker/issues/new/choose) and include your Vencord version and Discord build (Settings -> scroll to the bottom of the left sidebar).

## Credits

This is a combination of two existing plugins, both licensed under GPL-3.0:

- Dashboard, heatmap, voice sessions and timeline UI are based on [Discord-Activity-Tracker](https://github.com/elioflex/Discord-Activity-Tracker) by Elioflex.
- Profile-change and typing tracking are based on the [Activity Tracker](https://github.com/Ondra-D/vencord-activity-tracker) plugin by Ondra-D.

On top of that, this version stores logs in real per-user files instead of `settings.json` (no 1000-entry cap, no settings bloat) and merges all features into a single plugin.

## Disclaimer

For educational purposes. Using Vencord and third-party modifications is against Discord's Terms of Service. Use at your own risk.

## License

[GPL-3.0-or-later](LICENSE), the same license as Vencord.

## Author

Made by [MagicKey08](https://github.com/MagicKey08).
