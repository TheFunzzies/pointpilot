param(
  [Parameter(Mandatory=$true)][string]$Owner,
  [string]$Repo = "pointpilot"
)
$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required. Install Git for Windows first." }

Write-Host "Configuring PointPilot for GitHub: https://github.com/$Owner/$Repo" -ForegroundColor Cyan
npm run configure-github -- $Owner $Repo
if ($LASTEXITCODE -ne 0) { throw "GitHub configuration failed." }

if (-not (Test-Path .git)) {
  git init
  git branch -M main
}

git add .
git commit -m "PointPilot 0.5.0: GitHub releases and auto-update support"

Write-Host "`nCreate an empty GitHub repository at:" -ForegroundColor Yellow
Write-Host "https://github.com/new?name=$Repo"
Write-Host "Then run these commands if this repo does not already have an origin:" -ForegroundColor Yellow
Write-Host "git remote add origin https://github.com/$Owner/$Repo.git"
Write-Host "git push -u origin main"
Write-Host "git tag v0.5.0"
Write-Host "git push origin v0.5.0"
Write-Host "`nPushing v0.5.0 triggers GitHub Actions to build and publish the Windows release." -ForegroundColor Green
