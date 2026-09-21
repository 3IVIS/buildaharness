# Aielia CLI installer — Windows (PowerShell 5.1+ / 7+).
#
#   irm https://myaielia.com/install.ps1 | iex
#
# Resolves the product-scoped manifest https://myaielia.com/aielia-latest.json (never GitHub's
# repo-wide /releases/latest), downloads aielia-win32-x64.exe from the tag-scoped release URL it
# names, verifies its sha256 against the manifest (the `<asset>.sha256` sidecar is a cross-check:
# it must agree if reachable), and installs it to %LOCALAPPDATA%\Aielia\aielia.exe
# (or $env:AIELIA_INSTALL_DIR\aielia.exe), then adds that directory to the *user* PATH.
#
# Idempotent: re-running upgrades in place, or says "already up to date". Refuses to overwrite an
# unrelated file at the target path unless $env:AIELIA_FORCE = '1' (the `irm | iex` form can't take
# parameters, so --force's equivalent is an environment variable).
# HTTPS only; hard-fails on any other scheme (test-only: $env:AIELIA_INSTALL_ALLOW_INSECURE = '1'
# together with $env:AIELIA_MANIFEST_URL — never set these in real use).
#
# Everything lives in Install-Aielia and is only invoked on the last line, so a truncated
# download can never execute half a script.

function Install-Aielia {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar makes downloads ~10x slower on 5.1

  $allowInsecure = ($env:AIELIA_INSTALL_ALLOW_INSECURE -eq '1')
  $force = ($env:AIELIA_FORCE -eq '1')
  $manifestUrl = if ($env:AIELIA_MANIFEST_URL) { $env:AIELIA_MANIFEST_URL } else { 'https://myaielia.com/aielia-latest.json' }

  function Assert-Https([string]$Url) {
    if ($Url -like 'https://*') { return }
    if ($allowInsecure -and ($Url -like 'http://*' -or $Url -like 'file://*')) { return }
    throw "Refusing non-HTTPS URL: $Url"
  }

  function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  }

  # Windows PowerShell 5.1 may default to TLS 1.0/1.1; GitHub and Cloudflare need 1.2+.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  # The only prebuilt Windows binary is x64 (it also runs under ARM64 emulation).
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if ($arch -notin @('AMD64', 'ARM64')) {
    throw "No prebuilt aielia binary for Windows $arch. Use: npx @buildaharness/aielia"
  }
  $platformKey = 'win32-x64'

  $installDir = if ($env:AIELIA_INSTALL_DIR) { $env:AIELIA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Aielia' }
  $target = Join-Path $installDir 'aielia.exe'

  Write-Host 'Fetching the Aielia release manifest...'
  Assert-Https $manifestUrl
  try {
    $manifest = (Invoke-WebRequest -UseBasicParsing -Uri $manifestUrl).Content
    if ($manifest -is [byte[]]) { $manifest = [Text.Encoding]::UTF8.GetString($manifest) }
    $manifest = $manifest | ConvertFrom-Json
  } catch {
    throw "Could not download or parse $manifestUrl : $($_.Exception.Message)"
  }

  $tag = [string]$manifest.tag
  $version = [string]$manifest.version
  if (-not $tag.StartsWith('aielia-v')) { throw "Manifest carries an unexpected tag: '$tag'" }
  $asset = $manifest.assets.$platformKey
  if (-not $asset -or -not $asset.url) { throw "Release $tag has no binary for $platformKey" }
  $expected = ([string]$asset.sha256).ToLowerInvariant()
  if ($expected -notmatch '^[0-9a-f]{64}$') { throw "Manifest has no valid sha256 for $platformKey" }
  $assetUrl = [string]$asset.url
  Assert-Https $assetUrl

  # Existing file at the target path: upgrade an aielia binary, refuse anything else without AIELIA_FORCE=1.
  if (Test-Path -LiteralPath $target) {
    $installed = ''
    try { $installed = (& $target --version 2>$null | Select-Object -First 1) } catch { }
    if ($installed -match '^\d+\.\d+\.\d+') {
      if ($installed -eq $version) {
        Write-Host "aielia $installed is already installed at $target - up to date."
        return
      }
      Write-Host "Upgrading aielia $installed -> $version"
    } elseif (-not $force) {
      throw "$target already exists and is not an aielia binary. Set `$env:AIELIA_FORCE = '1' and re-run to replace it."
    } else {
      Write-Host "Replacing existing $target (AIELIA_FORCE)"
    }
  } else {
    Write-Host "Installing aielia $version"
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("aielia-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $download = Join-Path $tmp 'aielia.exe'
    Write-Host "Downloading $assetUrl"
    Invoke-WebRequest -UseBasicParsing -Uri $assetUrl -OutFile $download

    $actual = Get-Sha256 $download
    if ($actual -ne $expected) { throw "Checksum mismatch (manifest $expected, downloaded $actual) - download discarded" }

    # The sidecar next to the binary is a cross-check: if reachable it must agree with the manifest.
    try {
      Assert-Https "$assetUrl.sha256"
      $sidecarText = (Invoke-WebRequest -UseBasicParsing -Uri "$assetUrl.sha256").Content
      if ($sidecarText -is [byte[]]) { $sidecarText = [Text.Encoding]::UTF8.GetString($sidecarText) }
      if ($sidecarText -match '(?i)\b([0-9a-f]{64})\b') { $sidecar = $Matches[1].ToLowerInvariant() } else { $sidecar = $null }
    } catch { $sidecar = $null }
    if ($sidecar -and $sidecar -ne $expected) { throw 'Checksum sidecar disagrees with the release manifest - download discarded' }
    Write-Host "Checksum verified (sha256 $actual)"

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    # A running aielia.exe can't be overwritten but can be renamed aside (the CLI cleans up
    # aielia.exe.old on its next launch).
    if (Test-Path -LiteralPath $target) {
      $old = "$target.old"
      if (Test-Path -LiteralPath $old) { Remove-Item -Force -LiteralPath $old -ErrorAction SilentlyContinue }
      Move-Item -Force -LiteralPath $target -Destination $old
    }
    Move-Item -Force -LiteralPath $download -Destination $target
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  }

  Write-Host "Installed aielia $version to $target"

  # User-scoped PATH only (never machine-wide); skipped when the directory is already there.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @()
  if ($userPath) { $entries = $userPath.Split(';') | Where-Object { $_ } }
  $normalized = $installDir.TrimEnd('\')
  if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $normalized })) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $installDir) -join ';'), 'User')
    Write-Host ''
    Write-Host "Added $installDir to your user PATH - open a new terminal for it to take effect."
  }
  Write-Host ''
  Write-Host 'Run: aielia        (updates later: aielia update)'
}

Install-Aielia
