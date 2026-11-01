#requires -Version 5.1
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

if (-not (Get-Command "node" -ErrorAction SilentlyContinue) -or -not (Get-Command "npm" -ErrorAction SilentlyContinue)) {
    $ans = Read-Host ":: Node.js / npm is not installed. Install it now via winget? [Y/n]"
    if ([string]::IsNullOrWhiteSpace($ans)) { $ans = "Y" }
    if ($ans -match "^[Yy]") {
        Write-Host ":: Installing Node.js LTS (includes npm) via winget..." -ForegroundColor Cyan
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        Write-Host ":: Node.js and npm are required. Exiting." -ForegroundColor Yellow
        exit 1
    }
}

& node (Join-Path $ScriptDir "cli.mjs") @args
