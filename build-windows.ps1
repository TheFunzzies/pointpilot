$ErrorActionPreference = "Stop"
Write-Host "PointPilot Windows 11 build" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required. Install Node.js 22.12+ and rerun." }
$nodeVersion = node -p "process.versions.node"
Write-Host "Node.js $nodeVersion"
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
npm test
if ($LASTEXITCODE -ne 0) { throw "PointPilot tests failed." }
npm run dist
if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed." }
Write-Host "`nInstaller ready:" -ForegroundColor Green
Write-Host (Join-Path $PWD "dist\PointPilot-Setup-0.5.0.exe")
