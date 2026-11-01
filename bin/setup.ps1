#requires -Version 5.1
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Host ":: Node.js not found. Installing via winget..." -ForegroundColor Cyan
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

& node (Join-Path $ScriptDir "cli.mjs") @args
