# Security review — 2026-10-27

Scope: static review of the local HTTP server, Electron shell and IPC, provider URL opening, backup/restore paths, renderer output construction, and npm dependencies. This is an application-code review, not a penetration test or third-party certification.

## Changes made

- **Provider capture navigation:** the renderer-to-main `open-provider` IPC now validates both the provider ID and HTTPS hostname. It accepts only that provider's registered domain and subdomains, rejects credentials and unknown providers, and no longer relies on a naïve last-two-domain comparison. This prevents a renderer bug or injection from opening an attacker-controlled lookalike site in the persistent capture window.
- **Dependency advisories:** `npm audit fix` addressed the transitive `undici` and `fast-uri` advisories. Electron was pinned to 44.10.0 to address the remaining Electron advisory within the current major line. Full `npm audit` now reports zero vulnerabilities.
- **Local API boundaries reviewed:** the server binds to `127.0.0.1`, checks Host and Origin, requires JSON for state-changing calls, applies a same-origin CSP, uses body-size limits, and locks data while interrupted restores recover.
- **Renderer output reviewed:** dynamic templates generally pass data through `esc`/`safeUrl`; provider capture is now additionally allowlisted at the privileged IPC boundary.

## Remaining risks

1. **Credentials at rest — medium.** Third-party data API keys and the alert webhook URL are stored in the app's local `settings.json`. They are excluded from default backup export and masked in the UI, but local-file access can expose them. Before adding LLM credentials, migrate secrets to Windows Credential Manager / Electron `safeStorage` (and define a secure non-Electron development fallback). This needs a migration path and backup/restore tests; do not store new model keys in the existing plaintext settings document.
2. **Unsigned Windows update packages — medium.** The updater currently disables publisher signature verification because releases are not code-signed. HTTPS and GitHub release integrity still matter, but they do not provide publisher verification if the distribution account or update path is compromised. A signing certificate and a signed-release pipeline are required to re-enable signature verification without breaking updates.
3. **Local-network Ollama endpoints — future integration constraint.** Defaults should be loopback only. If custom remote model endpoints are ever supported, require an explicit opt-in, block private/link-local destinations by default, validate redirects, and clearly disclose that prompts leave the device.

## Positive controls observed

- Electron windows disable Node integration and enable context isolation and sandboxing.
- Main-window navigation is restricted to the app; external links open outside the app.
- The capture browser has no Node integration and is opened only for user-initiated manual searches.
- Backup exports are encrypted; restore previews validate before writes and imported alerts are inactive.
- API keys and webhook settings are omitted from backups unless explicitly opted in.

## Verification

- `npm audit`: 0 vulnerabilities after dependency updates.
- `npm run lint`: passed.
- `npm test`: 373 passed.
- Added `tests/providers-security.test.mjs` covering valid provider pages, lookalike domains, HTTP, credentials, and unknown provider IDs.
