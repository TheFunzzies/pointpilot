# PointPilot — Windows 11 Quick Start

## Build the installer once

1. Install Node.js 22.12 or newer on Windows 11.
2. Extract this folder.
3. Right-click inside the folder and choose **Open in Terminal**.
4. Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\build-windows.ps1
```

The script installs dependencies, runs the automated tests, and creates:

`dist\PointPilot-Setup-0.4.0.exe`

Run that installer to install PointPilot like a normal Windows application.

## Start the app

After installation, use the PointPilot shortcut from the Start menu or desktop.

The installed app does **not** require Node.js. Node is only needed on the computer that builds the installer.

## Where your data lives

Your wallet, alerts, award cache, captured pages, and historical observations live in PointPilot's Windows user-data folder. The exact location is shown in **Data & System**.

Uninstalling the app does not intentionally erase that data folder. This is by design so a future PointPilot upgrade can reuse your accumulated history.

## Manual award search

Use **Manual Capture** in PointPilot. Choose **Open in PointPilot**, search the provider normally, then press **Ctrl+Shift+S**. PointPilot saves the rendered page locally. For the most reliable historical data, enter the exact award price in the Manual Capture form as well.

## Historical database

Every captured/authorized search returned through PointPilot is stored as a separate observation. Repeated searches are preserved rather than collapsed into one record, allowing PointPilot to learn observed price distributions over time.
