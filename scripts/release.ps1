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
$name = 'YouTube'

# ---------------------------------------------------------------- Android
# If ~\.gradle isn't writable here, use a Gradle folder inside the project and pass the signing settings along.
$gradleHome = Join-Path $env:USERPROFILE '.gradle'
$canWrite = $true
try { $probe = Join-Path $gradleHome '.ranch-write-test'; [IO.File]::WriteAllText($probe, 'x'); Remove-Item $probe -Force } catch { $canWrite = $false }
if (-not $canWrite) {
  if (-not $env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = Join-Path (Get-Location) 'android\.gradle-home' }
  Get-Content (Join-Path $gradleHome 'gradle.properties') -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '^(YTM_[A-Z_]+)=(.*)$' } |
    ForEach-Object { Set-Item -Path "env:ORG_GRADLE_PROJECT_$($Matches[1])" -Value $Matches[2] }
}
Push-Location android
try { Run '.\gradlew.bat' @('assembleRelease', '--no-daemon', '-q') } finally { Pop-Location }
Copy-Item "android\app\build\outputs\apk\release\$name-Android-$version.apk" 'dist\' -Force

$assets = @(
  "dist\YouTube-Setup-$version.exe",
  "dist\YouTube-Setup-$version.exe.blockmap",
  "dist\YouTube-Portable-$version.exe",
  'dist\latest.yml',
  "dist\YouTube-Android-$version.apk"
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
- **YouTube-Android-$version.apk**: Android app with ad blocking, SponsorBlock, dislike counts and background play. Its green Update button gets future versions.
- **YouTube-iOS-$version.ipa**: iPhone and iPad app (appears a few minutes after this release). Install it with AltStore or Sideloadly using your Apple ID.

Or install and update it from the [Ranch Launcher](https://github.com/KingCreeper531/ranch-launcher/releases/latest).

Windows may show a SmartScreen warning because the app isn't code-signed. Click **More info**, then **Run anyway**.
"@
}
$ghArgs = @('release', 'create', "v$version", '--repo', $repo, '--target', 'main', '--title', "YouTube v$version", '--notes', $Notes) + $assets
Run gh $ghArgs
Write-Host "Published https://github.com/$repo/releases/tag/v$version" -ForegroundColor Green