# PointPilot for Windows 11

PointPilot is a Windows 11 desktop rewards optimizer with manual capture, historical award-price tracking, and portfolio-aware trip optimization.

## Build the installer locally

Requirements: Windows 11, Node.js 22.12+, Git, and internet access for npm downloads.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\build-windows.ps1
```

The installer is created at `dist\PointPilot-Setup-0.5.0.exe`.

## Configure GitHub Releases + automatic updates

The application uses `electron-updater` with GitHub Releases. Windows NSIS packages are supported by electron-updater, and electron-builder generates the `latest.yml` update metadata used by the updater.

The repository is already configured for `TheFunzzies/pointpilot`. A tag such as `v0.5.0` starts `.github/workflows/release.yml`, which runs tests, builds the Windows NSIS installer, and publishes the assets to the GitHub Release using the repository's `GITHUB_TOKEN`.

For later releases, bump `version` in `package.json`, commit, tag (for example `v0.6.0`), and push the tag. Installed PointPilot copies will check the GitHub release feed for a newer version.

## Update behavior

PointPilot checks for updates shortly after startup. The user can also select **PointPilot → Check for Updates**.

When an update is available, PointPilot lets the user download it and then install/restart. Existing user data is stored in the Electron user-data directory and is not replaced by an application update.

### Security note

The initial build is configured with Authenticode signature verification disabled because no Windows code-signing certificate is included in this development package. Before distributing PointPilot broadly, configure Windows code signing in GitHub Actions and restore `autoUpdater.verifyUpdateCodeSignature = true` in `desktop/main.cjs`.

## Data persistence

User balances, alerts, captured pages, award cache, and historical observations are stored under the Windows Electron user-data directory rather than inside the installed application folder.
