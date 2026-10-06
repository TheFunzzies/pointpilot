$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.12+ is required to build PointPilot.' }
npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' }
npm test; if ($LASTEXITCODE) { throw 'Tests failed' }
npm run dist; if ($LASTEXITCODE) { throw 'Installer build failed' }
$version = node -p "require('./package.json').version"
Write-Host "Installer ready: dist\PointPilot-Setup-$version.exe" -ForegroundColor Green
