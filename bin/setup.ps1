#requires -Version 5.1
param(
    [switch]$Doctor,
    [switch]$Sync,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$TARGET_DIR = "$HOME\.pi\agent"
$SCRIPT_DIR = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$T3_USERDATA = "$HOME\.t3\userdata"

function Test-CommandExists {
    param([string]$cmd)
    return (Get-Command $cmd -ErrorAction SilentlyContinue) -ne $null
}

# ========================================================
# HEALTH CHECK (DOCTOR)
# ========================================================
function Invoke-Doctor {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host "  🩺 System Health Check (Doctor)                         " -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host ""

    # Node & npm
    if (Test-CommandExists "node") {
        Write-Host "  [✓] Node.js: $(node -v)" -ForegroundColor Green
    } else {
        Write-Host "  [✗] Node.js: Not found" -ForegroundColor Red
    }

    if (Test-CommandExists "npm") {
        Write-Host "  [✓] npm: v$(npm -v)" -ForegroundColor Green
    } else {
        Write-Host "  [✗] npm: Not found" -ForegroundColor Red
    }

    # Core CLI Tools
    foreach ($cmd in @("git", "rg")) {
        if (Test-CommandExists $cmd) {
            Write-Host "  [✓] $cmd: Installed" -ForegroundColor Green
        } else {
            Write-Host "  [!] $cmd: Not found (recommended)" -ForegroundColor Yellow
        }
    }

    # Pi CLI
    if (Test-CommandExists "pi") {
        try {
            $piVer = pi --version
            Write-Host "  [✓] Pi CLI: v$piVer" -ForegroundColor Green
        } catch {
            Write-Host "  [✓] Pi CLI: Installed" -ForegroundColor Green
        }
    } else {
        Write-Host "  [✗] Pi CLI: Not found on PATH" -ForegroundColor Red
    }

    # Pi Config & Skills
    if (Test-Path "$TARGET_DIR\settings.json") {
        $skillsCount = 0
        if (Test-Path "$TARGET_DIR\skills") {
            $skillsCount = (Get-ChildItem -Directory "$TARGET_DIR\skills").Count
        }
        Write-Host "  [✓] Pi Config: Loaded ($skillsCount custom skills in $TARGET_DIR\skills)" -ForegroundColor Green
        $agentsSkills = Join-Path $HOME ".agents\skills"
        if (Test-Path $agentsSkills) {
            Write-Host "  [✓] Cross-Agent Skills: Active ($HOME\.agents\skills)" -ForegroundColor Green
        } else {
            Write-Host "  [!] Cross-Agent Skills: Not linked ($HOME\.agents\skills)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [✗] Pi Config: Missing ($TARGET_DIR\settings.json not found)" -ForegroundColor Red
    }

    # Pi Auth
    if (Test-Path "$TARGET_DIR\auth.json") {
        Write-Host "  [✓] Pi Auth: Authenticated credentials present ($TARGET_DIR\auth.json)" -ForegroundColor Green
    } else {
        Write-Host "  [!] Pi Auth: Not authenticated (run 'pi' and '/login')" -ForegroundColor Yellow
    }

    # T3 Code Desktop
    $t3Desktop = (Test-Path "$env:LOCALAPPDATA\Programs\t3code\T3 Code.exe") -or (Test-Path "$env:LOCALAPPDATA\Programs\t3code\t3code.exe")
    if ($t3Desktop) {
        Write-Host "  [✓] T3 Code: Desktop app installed" -ForegroundColor Green
    } else {
        Write-Host "  [!] T3 Code: Desktop app not detected in LocalAppData" -ForegroundColor Yellow
    }

    # T3 Settings
    $settingsFile = Join-Path $T3_USERDATA "settings.json"
    if (Test-Path $settingsFile) {
        try {
            $s = Get-Content -Raw $settingsFile | ConvertFrom-Json
            if ($s.providerInstances.pi.enabled -eq $true) {
                Write-Host "  [✓] T3 Engine: Pi provider enabled in settings.json" -ForegroundColor Green
            } else {
                Write-Host "  [!] T3 Engine: Pi provider not enabled in settings.json" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "  [!] T3 Engine: settings.json exists but could not be parsed" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [!] T3 Settings: $settingsFile not found" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Cyan
}

# ========================================================
# SYNC PROCEDURE (T3 + Pi -> Repo)
# ========================================================
function Invoke-Sync {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host "  🔄 Sync Live Settings to Project Repository             " -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host ""

    if (Test-Path $T3_USERDATA) {
        Write-Host ":: Syncing T3 Code configs from $T3_USERDATA -> $SCRIPT_DIR\t3..." -ForegroundColor Cyan
        $destDir = Join-Path $SCRIPT_DIR "t3"
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Force -Path $destDir | Out-Null
        }

        foreach ($file in @("client-settings.json", "desktop-settings.json", "keybindings.json", "keybindings-migrations")) {
            $src = Join-Path $T3_USERDATA $file
            if (Test-Path $src) {
                Copy-Item $src (Join-Path $destDir $file) -Force
                Write-Host "   [✓] $file" -ForegroundColor Green
            }
        }

        $settingsPath = Join-Path $T3_USERDATA "settings.json"
        if (Test-Path $settingsPath) {
            try {
                $data = Get-Content -Raw $settingsPath | ConvertFrom-Json
                if ($data.providerInstances) {
                    foreach ($prop in $data.providerInstances.PSObject.Properties) {
                        if ($prop.Value.config -and $prop.Value.config.apiKey) {
                            $prop.Value.config.apiKey = ""
                        }
                    }
                }
                $data | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $destDir "settings.json") -Encoding UTF8
                Write-Host "   [✓] settings.json (sanitized secrets)" -ForegroundColor Green
            } catch {
                Write-Host "   [!] Error sanitizing settings.json: $_" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host ":: ⚠️  T3 Code userdata directory not found: $T3_USERDATA" -ForegroundColor Yellow
    }

    Write-Host ""
    if (Get-Command git -ErrorAction SilentlyContinue) {
        git -C "$SCRIPT_DIR" status --short
    }
    Write-Host ""
    Write-Host "✨ Sync complete! You can now review changes with 'git diff' and commit them." -ForegroundColor Cyan
}

# ========================================================
# UNINSTALL PROCEDURE
# ========================================================
function Invoke-Uninstall {
    Write-Host ""
    Write-Host ":: ⚠️  UNINSTALL PROCEDURE" -ForegroundColor Red
    $confirm = Read-Host ":: Are you sure you want to completely remove Pi Agent and T3 Code? [y/N]"
    if ($confirm -notmatch "^[Yy]$") {
        Write-Host ":: Uninstall cancelled." -ForegroundColor Yellow
        exit 0
    }

    Write-Host ":: 1/5 Unlinking T3 Connect..." -ForegroundColor Cyan
    try { & t3 connect unlink 2>$null } catch {}

    Write-Host ":: 2/5 Removing Pi CLI globally..." -ForegroundColor Cyan
    try { npm uninstall -g @earendil-works/pi-coding-agent } catch {}

    Write-Host ":: 3/5 Removing ~/.pi directory..." -ForegroundColor Cyan
    if (Test-Path "$HOME\.pi") { Remove-Item -Recurse -Force "$HOME\.pi" }

    Write-Host ":: 4/5 Uninstalling T3 Code Desktop..." -ForegroundColor Cyan
    $uninstaller = "$env:LOCALAPPDATA\Programs\t3code\Uninstall T3 Code.exe"
    if (Test-Path $uninstaller) {
        Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait
    }

    Write-Host ":: 5/5 Removing ~/.t3 directory..." -ForegroundColor Cyan
    if (Test-Path "$HOME\.t3") { Remove-Item -Recurse -Force "$HOME\.t3" }

    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "  ✨ Uninstallation completed successfully!               " -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
}

# ========================================================
# INSTALL / UPDATE PROCEDURE
# ========================================================
function Invoke-Install {
    Write-Host ""
    Write-Host ":: Step 1/4: Checking core system dependencies..." -ForegroundColor Cyan
    $wingetAvailable = Test-CommandExists "winget"

    if (-not (Test-CommandExists "node")) {
        if ($wingetAvailable) {
            Write-Host ":: Installing Node.js LTS via winget..." -ForegroundColor Cyan
            winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        }
    }
    if (-not (Test-CommandExists "git")) {
        if ($wingetAvailable) {
            Write-Host ":: Installing Git via winget..." -ForegroundColor Cyan
            winget install Git.Git --silent --accept-package-agreements --accept-source-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        }
    }
    if (-not (Test-CommandExists "rg")) {
        if ($wingetAvailable) {
            Write-Host ":: Installing ripgrep via winget..." -ForegroundColor Cyan
            winget install BurntSushi.ripgrep.MSVC --silent --accept-package-agreements --accept-source-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        }
    }

    # 2. Configure npm user prefix
    Write-Host ""
    Write-Host ":: Step 2/4: Configuring npm user prefix..." -ForegroundColor Cyan
    $npmPrefix = "$HOME\.npm-global"
    New-Item -ItemType Directory -Force -Path $npmPrefix | Out-Null
    npm config set prefix $npmPrefix
    $env:Path = "$npmPrefix;$env:Path"

    # 3. Install / Sync Pi Coding Agent
    Write-Host ""
    Write-Host ":: Step 3/4: Setting up Pi Coding Agent..." -ForegroundColor Cyan
    npm install -g @earendil-works/pi-coding-agent

    if ($SCRIPT_DIR -ne $TARGET_DIR) {
        Write-Host ":: Syncing configs and skills into $TARGET_DIR..." -ForegroundColor Cyan
        New-Item -ItemType Directory -Force -Path $TARGET_DIR | Out-Null
        Copy-Item "$SCRIPT_DIR\settings.json" "$TARGET_DIR\" -Force -ErrorAction SilentlyContinue
        Copy-Item "$SCRIPT_DIR\zentui.json" "$TARGET_DIR\" -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path "$TARGET_DIR\extensions" | Out-Null
        Copy-Item -Recurse -Force "$SCRIPT_DIR\extensions\*" "$TARGET_DIR\extensions\" -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path "$TARGET_DIR\skills" | Out-Null
        Copy-Item -Recurse -Force "$SCRIPT_DIR\skills\*" "$TARGET_DIR\skills\" -ErrorAction SilentlyContinue
        if (Test-Path "$SCRIPT_DIR\t3") {
            New-Item -ItemType Directory -Force -Path "$TARGET_DIR\t3" | Out-Null
            Copy-Item -Recurse -Force "$SCRIPT_DIR\t3\*" "$TARGET_DIR\t3\" -ErrorAction SilentlyContinue
        }
    } elseif (Test-Path "$TARGET_DIR\.git") {
        Write-Host ":: Pulling latest changes in $TARGET_DIR..." -ForegroundColor Cyan
        git -C $TARGET_DIR pull --ff-only -ErrorAction SilentlyContinue
    }

    Write-Host ":: Installing declared Pi extensions & themes..." -ForegroundColor Cyan
    Set-Location $TARGET_DIR
    pi update --extensions -ErrorAction SilentlyContinue


    # Link universal Agent Skills (~/.agents/skills) so T3 Code & all agents see them
    Write-Host ":: Linking universal Agent Skills ($HOME\.agents\skills)..." -ForegroundColor Cyan
    $agentsDir = Join-Path $HOME ".agents"
    if (-not (Test-Path $agentsDir)) {
        New-Item -ItemType Directory -Force -Path $agentsDir | Out-Null
    }
    $agentsSkills = Join-Path $HOME ".agents\skills"
    if (-not (Test-Path $agentsSkills)) {
        try {
            New-Item -ItemType SymbolicLink -Path $agentsSkills -Target "$TARGET_DIR\skills" -Force | Out-Null
        } catch {
            Copy-Item -Recurse -Force "$TARGET_DIR\skills" $agentsSkills -ErrorAction SilentlyContinue
        }
    }
    # 4. Optional: Configure T3 Code with Pi as default engine
    Write-Host ""
    Write-Host ":: Step 4/4: T3 Code integration..." -ForegroundColor Cyan
    $setupT3 = Read-Host ":: Would you like to configure T3 Code to use Pi as its default agent engine? [Y/n]"
    if ([string]::IsNullOrWhiteSpace($setupT3)) { $setupT3 = "Y" }

    if ($setupT3 -match "^[Yy]$") {
        $isT3DesktopInstalled = (Test-Path "$env:LOCALAPPDATA\Programs\t3code\T3 Code.exe") -or (Test-Path "$env:LOCALAPPDATA\Programs\t3code\t3code.exe")
        if (-not $isT3DesktopInstalled) {
            Write-Host ":: T3 Code Desktop was not detected on this machine." -ForegroundColor Yellow
            $installT3 = Read-Host ":: Would you like to download and install T3 Code Nightly Desktop app now? [Y/n]"
            if ([string]::IsNullOrWhiteSpace($installT3)) { $installT3 = "Y" }

            if ($installT3 -match "^[Yy]$") {
                Write-Host ":: Fetching latest T3 Code Nightly Desktop release from GitHub..." -ForegroundColor Cyan
                try {
                    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=20" -Headers @{ "User-Agent" = "t3-install" }
                    $nightly = $releases | Where-Object { -not $_.draft -and $_.tag_name -match '^v\d+\.\d+\.\d+-nightly' } | Select-Object -First 1
                    $asset = $nightly.assets | Where-Object { $_.name -match 'T3-Code-.*-x64\.exe$' } | Select-Object -First 1
                    if ($asset) {
                        $installerPath = Join-Path $env:TEMP $asset.name
                        Write-Host ":: Downloading $($asset.name)..." -ForegroundColor Cyan
                        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installerPath
                        Write-Host ":: Launching T3 Code installer..." -ForegroundColor Cyan
                        Start-Process -FilePath $installerPath -Wait
                        Write-Host ":: T3 Code Desktop installation completed!" -ForegroundColor Green
                    }
                } catch {
                    Write-Warning "Could not fetch desktop installer directly: $_. Falling back to CLI installer..."
                    $env:T3CODE_CHANNEL = "nightly"
                    Invoke-Expression "& { $(Invoke-RestMethod 'https://t3.codes/install.ps1') }"
                }
            }
        } else {
            Write-Host ":: T3 Code Desktop is already installed." -ForegroundColor Green
        }

        Write-Host ":: Configuring T3 Code settings to use Pi engine..." -ForegroundColor Cyan
        if (-not (Test-Path $T3_USERDATA)) {
            New-Item -ItemType Directory -Force -Path $T3_USERDATA | Out-Null
        }

        foreach ($file in @("client-settings.json", "desktop-settings.json", "keybindings.json", "keybindings-migrations")) {
            $srcFile = Join-Path "$TARGET_DIR\t3" $file
            if (Test-Path $srcFile) {
                Copy-Item $srcFile "$T3_USERDATA\" -Force -ErrorAction SilentlyContinue
            }
        }
        if ((Test-Path "$TARGET_DIR\t3\settings.json") -and (-not (Test-Path "$T3_USERDATA\settings.json"))) {
            Copy-Item "$TARGET_DIR\t3\settings.json" "$T3_USERDATA\" -Force -ErrorAction SilentlyContinue
        }

        $settingsFile = Join-Path $T3_USERDATA "settings.json"
        $settings = @{}
        if (Test-Path $settingsFile) {
            try {
                $rawJson = Get-Content -Path $settingsFile -Raw
                $settings = ConvertFrom-Json $rawJson -AsHashtable
            } catch {
                $settings = @{}
            }
        }

        $settings["defaultModelSelection"] = @{
            instanceId = "pi"
            model = "antigravity/gemini-3.8-flash"
        }

        if (-not $settings.ContainsKey("providerInstances") -or ($settings["providerInstances"] -eq $null)) {
            $settings["providerInstances"] = @{}
        }
        $settings["providerInstances"]["pi"] = @{
            driver = "pi"
            displayName = "Pi"
            enabled = $true
        }

        $updatedJson = ConvertTo-Json $settings -Depth 10
        Set-Content -Path $settingsFile -Value $updatedJson -Encoding UTF8
        Write-Host ":: Set Pi as default engine in $settingsFile" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "  ✨ Setup completed successfully!                        " -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    if (-not (Test-Path "$TARGET_DIR\auth.json")) {
        Write-Host ":: 🔑 Next step: Run 'pi' in your terminal and type '/login' to authenticate." -ForegroundColor Yellow
    } else {
        Write-Host ":: 🔑 Credentials found. Pi is ready to use!" -ForegroundColor Green
    }
}

# ========================================================
# DISPATCHER
# ========================================================
if ($Doctor) {
    Invoke-Doctor
    exit 0
}
if ($Sync) {
    Invoke-Sync
    exit 0
}
if ($Uninstall) {
    Invoke-Uninstall
    exit 0
}

# ========================================================
# INTERACTIVE MENU
# ========================================================
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  🚀 Pi Agent + T3 Code Universal Manager (Windows)       " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Select an option:" -ForegroundColor Yellow
Write-Host "  [1] Install / Update (Pi Agent + T3 Code)"
Write-Host "  [2] Run Health Check (Doctor)"
Write-Host "  [3] Sync T3 Code Settings to Repo"
Write-Host "  [4] Uninstall Everything"
Write-Host "  [5] Exit"
Write-Host ""
$choice = Read-Host "Enter choice [1-5] (default: 1)"
if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "1" }

switch ($choice) {
    "1" { Invoke-Install }
    "2" { Invoke-Doctor }
    "3" { Invoke-Sync }
    "4" { Invoke-Uninstall }
    "5" { Write-Host ":: Exiting." -ForegroundColor Yellow; exit 0 }
    Default { Write-Host ":: Invalid choice." -ForegroundColor Red; exit 1 }
}
