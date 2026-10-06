# PointPilot

A Windows desktop app that finds award flights and works out the cheapest way to pay for them from your own mix of airline miles, hotel points and transferable bank points.

- **Live award search** for flights through the [seats.aero](https://seats.aero) Partner API, and for hotels (Hilton, Hyatt, IHG, Marriott, Choice, Wyndham, I Prefer) through its sister service [rooms.aero](https://rooms.aero). Both are optional and use the same seats.aero Pro key, each with its own daily quota. Manual entry covers anything else.
- **Portfolio-aware optimizer** that funds the *whole trip* for *all travelers*. It uses miles you already hold first, then picks bank transfers by your own ¢/point values. It respects transfer minimums and increments, time-limited bonuses, the Marriott 60k→25k bonus, slow transfers and a max-transfers limit.
- **Cash fares**: search cash prices, set **price alerts** (below a target, or a set % below the route's usual price), and get a **deals feed** from your home airports. This uses a free [Travelpayouts](https://www.travelpayouts.com) token (recent Aviasales fares). An optional [SerpApi](https://serpapi.com) key (free: 250 searches/month) adds live Google Flights prices, Google's low/typical/high rating and cabin-aware "points vs. cash" comparisons on award results.
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

**Transfer data is cross-checked daily.** The *Transfer partner check* workflow compares `reference/transfer-partners.json` with Roame, Upgraded Points and The Points Guy. It auto-applies only changes that at least two sources agree on (or that every source covering that currency agrees on, e.g. Roame for Hyatt/Accor), plus live bonuses from Roame with a rolling 7-day end date. It records which sources verified each route and TPG's point valuations, and writes everything it didn't apply to `reference/transfer-check.md`. Run it locally with `node scripts/check-transfers.mjs`.

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
- **Pick your own flights:** award results list every individual flight for the outbound and return. You can filter by points, travel time, stops, departure time, seat quality and program, then select a pair; the recommended pair is pre-selected. Seat quality comes from `reference/cabin-products.json` (Qsuite, Delta One Suite, ANA THE Room, JAL A350-1000…), which installed apps refresh from `main` like the transfer data. Edit it to add or correct products.
- **Trip Builder** assembles award flights, hotel stays and *positioning* flights (e.g. BOS→JFK before an award from JFK). It checks connection buffers and funds the whole trip at once. Positioning searches use Google Flights (SerpApi) for exact times, falling back to Travelpayouts, plus seats.aero economy awards.
- Seat-map links open the exact AeroLOPA/SeatMaps page for the airline and aircraft when one exists, otherwise the airline's page. Neither site supports flight-number links. PointPilot reads each site's airline index at most once a month to find the right page.
- Award flight details (local times, layovers, aircraft, booking links) come from seats.aero's per-award trip data, loaded automatically for the recommended trip (1 call per leg, cached 6 hours) and on demand for other options. Seat info is the *typical* product for the cabin and aircraft type: AeroLOPA and SeatMaps have no public API, so results link to their seat maps instead.
- Airport, city, country, airline names and time zones come from `reference/geo.json`, built from Travelpayouts' public data with `npm run build:geo`.
- rooms.aero prices stays of 1–5 nights. Longer stays are estimated from the 5-night price and marked **ESTIMATED**. Hotel prices are for one room.
- Travelpayouts prices are economy fares cached from Aviasales searches in about the last 48 hours, so less-popular routes can have gaps. A route's "usual price" is the median of the cheapest fare seen on each of the last 90 days. A fare is only called a deal once there are 3+ days of history, so deals get better the longer PointPilot runs.
- SerpApi quota is protected: Google is only queried when you tick "Check live Google Flights price", click "Compare with cash price", or once a day to confirm a triggered price alert.
- ITA Matrix has no API and doesn't allow automated querying, so it isn't integrated. Results link to a prefilled Google Flights search instead (Google Flights runs on the same ITA engine).
- seats.aero's summary data doesn't always include taxes. When taxes are unknown, the effective cost understates the real price, and the result says so.
- Routes marked **UNVERIFIED** in Transfer Partners were added from long-standing public partner lists. Confirm them on Roame before moving points; transfers are irreversible.
- PointPilot never automates airline or hotel websites or bypasses bot checks. The capture window is a normal browser for searching manually.
