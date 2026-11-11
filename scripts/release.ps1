# Builds the YouTube app and publishes a GitHub release with:
#   - YouTube-Setup-<version>.exe     (installer, updates itself)
#   - YouTube-Portable-<version>.exe  (no install needed)
#   - latest.yml + .blockmap          (used by the in-app Update button)
#
# Usage:  npm run release                      -> bumps patch (1.0.0 -> 1.0.1) if this version is already out
#         npm run release -- -Bump minor       -> 1.0.0 -> 1.1.0
#         npm run release -- -Notes "Fixed X"  -> custom release notes
param(
  [ValidateSet('patch', 'minor', 'major')] [string]$Bump = 'patch',
  [string]$Notes = ''
)
# Native tools write progress to stderr; Windows PowerShell 5.1 would treat that
# as fatal under 'Stop'. Failures are caught by exit codes in Run() instead.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed (exit $LASTEXITCODE)" }
}

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { throw "YouTube releases come from the main branch (you're on '$branch'). Run: git checkout main" }

$repo = 'KingCreeper531/youtube-desktop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

# Only bump if this version was already released.
& gh release view "v$version" --repo $repo *> $null
if ($LASTEXITCODE -eq 0) {
  Run npm @('version', $Bump, '--no-git-tag-version')
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
}
Write-Host "Releasing YouTube v$version" -ForegroundColor Green

if (Test-Path dist) { Remove-Item -Recurse -Force dist }
Run npx @('electron-builder', '--win', '--publish', 'never')

$assets = @(
  "dist\YouTube-Setup-$version.exe",
  "dist\YouTube-Setup-$version.exe.blockmap",
  "dist\YouTube-Portable-$version.exe",
  'dist\latest.yml'
)
foreach ($a in $assets) { if (-not (Test-Path $a)) { throw "Missing build output: $a" } }

# Commit and push the source for this version.
Run git @('add', '-A')
& git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Run git @('commit', '-m', "Release v$version") }
Run git @('push', 'origin', 'HEAD')

if (-not $Notes) {
  $Notes = @"
## Download
- **YouTube-Setup-$version.exe**: installer (recommended). Updates itself with the green Update button.
- **YouTube-Portable-$version.exe**: runs without installing.

Or install and update it from the [Ranch Launcher](https://github.com/KingCreeper531/ranch-launcher/releases/latest).

Windows may show a SmartScreen warning because the app isn't code-signed. Click **More info**, then **Run anyway**.
"@
}
$ghArgs = @('release', 'create', "v$version", '--repo', $repo, '--target', 'main', '--title', "YouTube v$version", '--notes', $Notes) + $assets
Run gh $ghArgs
Write-Host "Published https://github.com/$repo/releases/tag/v$version" -ForegroundColor Green