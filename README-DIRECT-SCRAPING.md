# PointPilot Direct / Manual Data Layer

This build removes the architectural dependency on Seats.aero / Rooms.aero.

## Manual capture

`npm run capture -- <provider>` opens the provider's normal website in a persistent visible browser. The user performs the search themselves and presses Enter in the terminal when results are visible. PointPilot saves the rendered HTML to `data/captures/`.

No CAPTCHA bypass, stealth automation, credential harvesting, proxy rotation, rate-limit circumvention, or access-control evasion is implemented.

## Authorized direct connector

Only providers explicitly marked `authorized` and included in `AUTHORIZED_DIRECT_PROVIDERS` can be automatically parsed. Provider-specific selectors are kept in `scraper/provider-registry.mjs`.

## Historical ingestion

- `scraper/price-history.mjs` is the provenance-aware historical datastore.
- `scraper/ingest.mjs` adds captured award rows to the award cache and historical observations.
- `historical/price-history-seed.json` contains sourced benchmark history.
- `historical/seed-history.mjs` loads the public benchmark set.

A future provider-specific manual parser can be added without changing the optimizer: it only has to emit normalized PointPilot award records.
