# PointPilot

A Windows desktop app that finds award flights and works out the cheapest way to pay for them from your own mix of airline miles, hotel points and transferable bank points.

- **Live award search** through the [seats.aero](https://seats.aero) Partner API (optional, needs a seats.aero Pro key), plus manual entry for anything it doesn't cover.
- **Portfolio-aware optimizer** that funds the *whole trip* for *all travelers*. It uses miles you already hold first, then picks bank transfers by your own ¢/point values. It respects transfer minimums and increments, time-limited bonuses, the Marriott 60k→25k bonus, slow transfers and a max-transfers limit.
- **Alerts** re-check saved trips in the background and show a Windows notification (and an optional Slack/Discord webhook) when new matching space appears.
- **Price history** from published award-chart benchmarks plus every price PointPilot sees, used to label deals ("12% below historical median").
- **Auto-updates**: the app downloads new GitHub Releases in the background, and transfer-partner data refreshes from this repo without a reinstall.

## Install

Download `PointPilot-Setup-x.y.z.exe` from [Releases](https://github.com/TheFunzzies/pointpilot/releases) and run it. The installer isn't code-signed yet, so Windows SmartScreen will warn you: choose **More info → Run anyway**.

Then open **Data & System** and paste your seats.aero API key (seats.aero → Settings → API). Without a key, searches use only awards you enter under **Manual Entry**.

## How data and updates work

| What | Where it lives | How it updates |
|---|---|---|
| App code | Install folder | GitHub Releases, downloaded in the background every 4 h; installs on restart/quit |
| Transfer partners | `reference/transfer-partners.json` | Bundled in the app, **plus** fetched from `main` on this repo twice a day (newer `lastUpdated` wins) |
| Your wallet, alerts, settings, award cache, history | `%APPDATA%\PointPilot\data` | Yours; never replaced by updates or removed on uninstall |

To correct a transfer ratio or add a bonus for every user: edit `reference/transfer-partners.json`, bump `lastUpdated`, and merge to `main`. CI validates the file, and installed apps pick it up within 12 hours. No release is needed.

## Develop

Requires Node.js 22.12+.

```powershell
npm ci
npm test          # unit + API tests
npm start         # web UI at http://127.0.0.1:3000 (data in .\data)
npm run desktop   # run the Electron app
npm run dist      # build dist\PointPilot-Setup-<version>.exe
```

### Layout

```
server.mjs            HTTP API + static UI (loopback only, rejects cross-site requests)
lib/optimizer.mjs     trip funding & ranking
lib/transfers.mjs     ratio / bonus / increment math
lib/search.mjs        gather awards, pair legs, rank trips
lib/seatsaero.mjs     seats.aero Partner API adapter
lib/monitor.mjs       alerts
lib/store.mjs         atomic, serialized JSON storage
reference/            bundled data (transfer partners, destinations, history seed)
desktop/              Electron shell (tray, notifications, auto-update)
```

## Release

1. Bump `version` in `package.json`, then run `npm install` so the lockfile picks up the new version. Commit both.
2. Tag and push: `git tag v0.6.1 && git push origin v0.6.1`.
3. The **Release** workflow tests, builds and publishes the installer, blockmap and `latest.yml`. Installed apps update themselves from there.

The release fails early if the tag doesn't match `package.json`, or if the lockfile is missing.

## Notes and limits

- seats.aero personal keys are for **non-commercial use** and allow about 1,000 calls a day. PointPilot reuses a result for the same search for 60 minutes (configurable) and shows the day's call count.
- seats.aero's summary data doesn't always include taxes. When taxes are unknown, the effective cost understates the real price, and the result says so.
- Routes marked **UNVERIFIED** in Transfer Partners were added from long-standing public partner lists. Confirm them on Roame before moving points; transfers are irreversible.
- PointPilot never automates airline or hotel websites or bypasses bot checks. The capture window is a normal browser for searching manually.
