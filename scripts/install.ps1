# Ghostping installer for Windows (PowerShell)
# Usage: irm https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.ps1 | iex

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\ghostping"
)

$ErrorActionPreference = "Stop"
$Repo = "commonfields/ghostping"
$Archive = "ghostping-windows-x86_64.zip"

# ── Get latest release ─────────────────────────────────────────────────────

Write-Host "Fetching latest release..."
$LatestUrl = "https://api.github.com/repos/$Repo/releases/latest"
try {
    $Release = Invoke-RestMethod -Uri $LatestUrl -Headers @{ "User-Agent" = "ghostping-installer" }
    $Tag = $Release.tag_name
} catch {
    Write-Error "Failed to fetch latest release: $_"
    exit 1
}

if (-not $Tag) {
    Write-Error "Could not determine latest release tag."
    exit 1
}

Write-Host "Installing ghostping $Tag (Windows x86_64)..."

# ── Download and install ───────────────────────────────────────────────────

$DownloadUrl = "https://github.com/$Repo/releases/download/$Tag/$Archive"
$TmpDir = Join-Path $env:TEMP "ghostping-install-$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    $ArchivePath = Join-Path $TmpDir $Archive
    Write-Host "Downloading $DownloadUrl..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath -UseBasicParsing

    Write-Host "Downloading checksum manifest..."
    $ChecksumsUrl = "https://github.com/$Repo/releases/download/$Tag/checksums.txt"
    $ChecksumsPath = Join-Path $TmpDir "checksums.txt"
    Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $ChecksumsPath -UseBasicParsing

    Write-Host "Verifying checksum..."
    $Expected = (Select-String -Path $ChecksumsPath -Pattern ([regex]::Escape($Archive) + "$") |
        Select-Object -First 1) -replace '^([0-9a-fA-F]+)\s+.*$', '$1'
    if (-not $Expected) {
        Write-Error "No checksum entry for $Archive in checksums.txt. Aborting install."
        exit 1
    }
    $Actual = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLower()
    if ($Actual -ne $Expected.ToLower()) {
        Write-Error "Checksum mismatch for $Archive. Expected $Expected, got $Actual. Aborting install."
        exit 1
    }
    Write-Host "Checksum OK."

    Write-Host "Extracting..."
    Expand-Archive -Path $ArchivePath -DestinationPath $TmpDir -Force

    # Create install directory
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir | Out-Null
    }

    $ExePath = Join-Path $TmpDir "ghostping.exe"
    $Destination = Join-Path $InstallDir "ghostping.exe"
    Copy-Item -Path $ExePath -Destination $Destination -Force

} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

# ── Add to PATH if needed ──────────────────────────────────────────────────

$CurrentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($CurrentPath -notlike "*$InstallDir*") {
    Write-Host "Adding $InstallDir to your PATH..."
    $NewPath = "$InstallDir;$CurrentPath"
    [Environment]::SetEnvironmentVariable("PATH", $NewPath, "User")
    $env:PATH = "$InstallDir;$env:PATH"
    Write-Host "  Note: restart your terminal for PATH changes to take effect."
}

# ── Verify ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ✓ ghostping $Tag installed to $Destination" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start:"
Write-Host "    ghostping quickstart"
Write-Host "    ghostping init --name `"MyProject`" --website `"https://example.com`" --yes"
Write-Host "    ghostping prompts discover"
Write-Host "    ghostping audit run --models mock --samples 3"
Write-Host ""
