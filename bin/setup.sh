#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="$HOME/.pi/agent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T3_USERDATA="$HOME/.t3/userdata"

# ========================================================
# HEALTH CHECK (DOCTOR)
# ========================================================
run_doctor() {
    echo ""
    echo "=========================================================="
    echo "  🩺 System Health Check (Doctor)                         "
    echo "=========================================================="
    echo ""

    # Node & npm
    if command -v node &>/dev/null; then
        echo -e "  \033[32m[✓]\033[0m Node.js: $(node -v) ($(command -v node))"
    else
        echo -e "  \033[31m[✗]\033[0m Node.js: Not found"
    fi

    if command -v npm &>/dev/null; then
        echo -e "  \033[32m[✓]\033[0m npm: v$(npm -v)"
    else
        echo -e "  \033[31m[✗]\033[0m npm: Not found"
    fi

    # CLI tools
    for cmd in git rg fd; do
        if command -v "$cmd" &>/dev/null; then
            echo -e "  \033[32m[✓]\033[0m $cmd: Installed ($(command -v "$cmd"))"
        else
            echo -e "  \033[33m[!]\033[0m $cmd: Not found (recommended)"
        fi
    done

    # Pi CLI
    if command -v pi &>/dev/null; then
        PI_VER=$(pi --version 2>/dev/null || echo "Installed")
        echo -e "  \033[32m[✓]\033[0m Pi CLI: v$PI_VER ($(command -v pi))"
    else
        echo -e "  \033[31m[✗]\033[0m Pi CLI: Not found on PATH"
    fi

    # Pi Config & Skills
    if [ -f "$TARGET_DIR/settings.json" ]; then
        SKILL_COUNT=$(find "$TARGET_DIR/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
        echo -e "  \033[32m[✓]\033[0m Pi Config: Loaded ($SKILL_COUNT custom skills in $TARGET_DIR/skills)"
        if [ -L "$HOME/.agents/skills" ] && [ "$(readlink "$HOME/.agents/skills")" = "$TARGET_DIR/skills" ]; then
            echo -e "  \033[32m[✓]\033[0m Cross-Agent Skills: Linked (~/.agents/skills -> $TARGET_DIR/skills)"
        elif [ -d "$HOME/.agents/skills" ]; then
            echo -e "  \033[33m[!]\033[0m Cross-Agent Skills: Directory exists at ~/.agents/skills (not symlinked)"
        else
            echo -e "  \033[33m[!]\033[0m Cross-Agent Skills: Not linked (~/.agents/skills)"
        fi
    else
        echo -e "  \033[31m[✗]\033[0m Pi Config: Missing ($TARGET_DIR/settings.json not found)"
    fi

    # Pi Auth
    if [ -f "$TARGET_DIR/auth.json" ]; then
        echo -e "  \033[32m[✓]\033[0m Pi Auth: Authenticated credentials present ($TARGET_DIR/auth.json)"
    else
        echo -e "  \033[33m[!]\033[0m Pi Auth: Not authenticated (run 'pi' and '/login')"
    fi

    # T3 Code
    if command -v t3code &>/dev/null || command -v t3 &>/dev/null; then
        T3_BIN=$(command -v t3code 2>/dev/null || command -v t3 2>/dev/null)
        echo -e "  \033[32m[✓]\033[0m T3 Code: Installed ($T3_BIN)"
    else
        echo -e "  \033[33m[!]\033[0m T3 Code: Not installed on PATH"
    fi

    # T3 Settings
    if [ -f "$T3_USERDATA/settings.json" ]; then
        IS_PI=$(node -e '
        try {
            const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            console.log(s.providerInstances?.pi?.enabled ? "yes" : "no");
        } catch { console.log("no"); }
        ' "$T3_USERDATA/settings.json" 2>/dev/null || echo "no")
        if [ "$IS_PI" = "yes" ]; then
            echo -e "  \033[32m[✓]\033[0m T3 Engine: Pi provider enabled in settings.json"
        else
            echo -e "  \033[33m[!]\033[0m T3 Engine: Pi provider not enabled in settings.json"
        fi
    else
        echo -e "  \033[33m[!]\033[0m T3 Settings: $T3_USERDATA/settings.json not found"
    fi

    echo ""
    echo "=========================================================="
}

# ========================================================
# SYNC PROCEDURE (T3 + Pi -> Repo)
# ========================================================
# Stage ONLY the files this sync owns, then commit + push. Anything else that
# happens to be dirty (work-in-progress) is deliberately left uncommitted.
commit_sync_changes() {
    local repo="$1" msg="$2"
    local paths=()
    local p
    for p in settings.json zentui.json skills themes t3; do
        [ -e "$repo/$p" ] && paths+=("$p")
    done

    git -C "$repo" add -- "${paths[@]}"
    if git -C "$repo" diff --cached --quiet; then
        echo ":: No sync-target changes to commit (other pending edits left untouched)."
        return 0
    fi
    git -C "$repo" commit -m "$msg"
    git -C "$repo" push origin main
    echo "✨ Changes committed and pushed to GitHub!"
}

run_sync() {
    local auto_push=false
    local custom_msg=""

    while [ $# -gt 0 ]; do
        case "$1" in
            --push|-p)
                auto_push=true
                shift
                ;;
            -m|--message)
                custom_msg="${2:-}"
                shift 2
                ;;
            *)
                if [ -z "$custom_msg" ]; then
                    custom_msg="$1"
                fi
                shift
                ;;
        esac
    done

    echo ""
    echo "=========================================================="
    echo "  🔄 Sync Live Settings to Project Repository             "
    echo "=========================================================="
    echo ""
    # 1. Sync Pi configuration if repo is cloned outside ~/.pi/agent
    if [ "$SCRIPT_DIR" != "$TARGET_DIR" ] && [ -d "$TARGET_DIR" ]; then
        echo ":: Syncing Pi settings & skills from $TARGET_DIR -> $SCRIPT_DIR..."
        cp -u "$TARGET_DIR/settings.json" "$SCRIPT_DIR/" 2>/dev/null || true
        cp -u "$TARGET_DIR/zentui.json" "$SCRIPT_DIR/" 2>/dev/null || true
        mkdir -p "$SCRIPT_DIR/skills"
        cp -ru "$TARGET_DIR/skills/." "$SCRIPT_DIR/skills/" 2>/dev/null || true
    else
        echo ":: Pi repo is active at $SCRIPT_DIR (skills & settings are live)."
    fi

    # 2. Sync T3 Code configuration from ~/.t3/userdata -> repo/t3
    if [ -d "$T3_USERDATA" ]; then
        echo ":: Syncing T3 Code configs from $T3_USERDATA -> $SCRIPT_DIR/t3..."
        mkdir -p "$SCRIPT_DIR/t3"

        # Machine-local / churny T3 files are intentionally NOT synced:
        #   desktop-settings.json  -> window geometry only, changes on every resize
        #   keybindings-migrations -> machine-generated migration ledger
        for file in keybindings.json; do
            if [ -f "$T3_USERDATA/$file" ]; then
                cp "$T3_USERDATA/$file" "$SCRIPT_DIR/t3/$file"
                echo "   [✓] $file"
            fi
        done

        # client-settings.json: strip volatile bookkeeping keys and pretty-print
        # so future diffs are per-key instead of one changed 2.8 KB line.
        if [ -f "$T3_USERDATA/client-settings.json" ]; then
            node -e '
            const fs = require("fs");
            const volatileKeys = ["onboardingCompletedAt", "dismissedProviderUpdateNotificationKeys"];
            try {
                const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
                for (const k of volatileKeys) delete data[k];
                fs.writeFileSync(process.argv[2], JSON.stringify(data, null, 2) + "\n", "utf8");
                console.log("   [✓] client-settings.json (volatile keys stripped)");
            } catch (e) {
                console.error("   [!] Error parsing client-settings.json:", e.message);
            }
            ' "$T3_USERDATA/client-settings.json" "$SCRIPT_DIR/t3/client-settings.json"
        fi

        # Sync and sanitize settings.json (strip plaintext API keys + volatile
        # timestamps before committing)
        if [ -f "$T3_USERDATA/settings.json" ]; then
            node -e '
            const fs = require("fs");
            const srcPath = process.argv[1];
            const destPath = process.argv[2];
            try {
                const data = JSON.parse(fs.readFileSync(srcPath, "utf8"));
                if (data.providerInstances) {
                    for (const p of Object.values(data.providerInstances)) {
                        if (p && p.config && typeof p.config.apiKey === "string") {
                            p.config.apiKey = "";
                        }
                    }
                }
                delete data.defaultThemeSetAt;
                fs.writeFileSync(destPath, JSON.stringify(data, null, 2) + "\n", "utf8");
                console.log("   [✓] settings.json (sanitized secrets)");
            } catch (e) {
                console.error("   [!] Error parsing settings.json:", e.message);
            }
            ' "$T3_USERDATA/settings.json" "$SCRIPT_DIR/t3/settings.json"
        fi
    else
        echo ":: ⚠️  T3 Code userdata directory ($T3_USERDATA) not found."
    fi

    echo ""
    echo ":: Checking Git changes..."
    if command -v git &>/dev/null && [ -d "$SCRIPT_DIR/.git" ]; then
        if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain)" ]; then
            git -C "$SCRIPT_DIR" status --short
            echo ""
            if [ "$auto_push" = true ]; then
                local msg="${custom_msg:-chore: sync live Pi and T3 settings [$(date +'%Y-%m-%d %H:%M')]}"
                echo ":: Staging sync targets, committing, and pushing to GitHub..."
                commit_sync_changes "$SCRIPT_DIR" "$msg"
            else
                read -rp ":: Changes detected. Would you like to commit and push now? [y/N]: " do_push || do_push="n"
                if [[ "$do_push" =~ ^[Yy]$ ]]; then
                    read -rp "Enter commit message (or press enter for default): " user_msg || user_msg=""
                    local msg="${user_msg:-chore: sync live Pi and T3 settings [$(date +'%Y-%m-%d %H:%M')]}"
                    commit_sync_changes "$SCRIPT_DIR" "$msg"
                fi
            fi
        else
            echo ":: Everything is already in sync with Git (no changes detected)."
        fi
    fi
}

# ========================================================
# UNINSTALL PROCEDURE
# ========================================================
run_uninstall() {
    echo ""
    echo ":: ⚠️  UNINSTALL PROCEDURE"
    read -rp ":: Are you sure you want to completely remove Pi Agent and T3 Code? [y/N]: " confirm || confirm="N"
    confirm="${confirm:-N}"
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo ":: Uninstall cancelled."
        exit 0
    fi

    echo ":: 1/5 Unlinking T3 Connect..."
    if command -v t3 &>/dev/null; then
        t3 connect unlink 2>/dev/null || true
    fi

    echo ":: 2/5 Removing Pi CLI globally..."
    npm uninstall -g @earendil-works/pi-coding-agent 2>/dev/null || true

    echo ":: 3/5 Removing ~/.pi directory..."
    rm -rf "$HOME/.pi"

    echo ":: 4/5 Uninstalling T3 Code..."
    if command -v yay &>/dev/null && (pacman -Qi t3code-nightly-bin &>/dev/null || pacman -Qi t3code-bin &>/dev/null); then
        yay -R --noconfirm t3code-nightly-bin 2>/dev/null || yay -R --noconfirm t3code-bin 2>/dev/null || true
    elif command -v apt-get &>/dev/null && dpkg -l t3code &>/dev/null; then
        sudo apt-get remove -y t3code 2>/dev/null || true
    elif command -v brew &>/dev/null; then
        brew uninstall --cask t3-code 2>/dev/null || true
    fi
    rm -f "$HOME/.local/bin/t3" "$HOME/.local/bin/t3code"

    echo ":: 5/5 Removing ~/.t3 directory..."
    rm -rf "$HOME/.t3"

    echo ""
    echo "=========================================================="
    echo "  ✨ Uninstallation completed successfully!               "
    echo "=========================================================="
}

# ========================================================
# INSTALL / UPDATE PROCEDURE
# ========================================================
install_prereqs() {
    local pkgs=("$@")
    echo ":: Installing missing dependencies: ${pkgs[*]}..."
    if command -v yay &>/dev/null; then
        yay -S --needed --noconfirm "${pkgs[@]}"
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --needed --noconfirm "${pkgs[@]}"
    elif command -v apt-get &>/dev/null; then
        sudo apt-get update && sudo apt-get install -y "${pkgs[@]}"
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y "${pkgs[@]}"
    elif command -v brew &>/dev/null; then
        brew install "${pkgs[@]}"
    else
        echo ":: ⚠️  Unknown package manager. Please ensure Node.js, npm, ripgrep, and fd are installed."
    fi
}

run_install() {
    echo ""
    echo ":: Step 1/4: Checking core system dependencies..."
    MISSING=()
    for cmd in node npm git rg fd; do
        if ! command -v "$cmd" &>/dev/null; then
            case "$cmd" in
                node) MISSING+=("nodejs") ;;
                rg)   MISSING+=("ripgrep") ;;
                *)    MISSING+=("$cmd") ;;
            esac
        fi
    done

    if [ ${#MISSING[@]} -gt 0 ]; then
        install_prereqs "${MISSING[@]}"
    else
        echo ":: All core dependencies found (node, npm, git, ripgrep, fd)."
    fi

    # 2. Configure npm user prefix (~/.local) so global installs do not need sudo
    echo ""
    echo ":: Step 2/4: Configuring npm global prefix..."
    mkdir -p "$HOME/.local/bin" "$HOME/.local/lib"
    npm config set prefix "$HOME/.local"
    export PATH="$HOME/.local/bin:$PATH"

    # 3. Install / Sync Pi Agent and Config
    echo ""
    echo ":: Step 3/4: Setting up Pi Coding Agent..."
    npm install -g @earendil-works/pi-coding-agent

    if [ "$SCRIPT_DIR" != "$TARGET_DIR" ]; then
        echo ":: Syncing configuration and skills into $TARGET_DIR..."
        mkdir -p "$TARGET_DIR"
        cp -u "$SCRIPT_DIR/settings.json" "$TARGET_DIR/" 2>/dev/null || true
        cp -u "$SCRIPT_DIR/zentui.json" "$TARGET_DIR/" 2>/dev/null || true
        mkdir -p "$TARGET_DIR/extensions"
        cp -ru "$SCRIPT_DIR/extensions/." "$TARGET_DIR/extensions/" 2>/dev/null || true
        mkdir -p "$TARGET_DIR/skills"
        cp -ru "$SCRIPT_DIR/skills/." "$TARGET_DIR/skills/" 2>/dev/null || true
        if [ -d "$SCRIPT_DIR/t3" ]; then
            mkdir -p "$TARGET_DIR/t3"
            cp -ru "$SCRIPT_DIR/t3/." "$TARGET_DIR/t3/" 2>/dev/null || true
        fi
    elif [ -d "$TARGET_DIR/.git" ]; then
        echo ":: Pulling latest changes in $TARGET_DIR..."
        git -C "$TARGET_DIR" pull --ff-only 2>/dev/null || true
    fi

    echo ":: Installing declared Pi extensions & themes..."
    cd "$TARGET_DIR"
    pi update --extensions || true

    # Link universal Agent Skills so T3 Code & all other agents see them
    echo ":: Linking universal Agent Skills (~/.agents/skills -> $TARGET_DIR/skills)..."
    mkdir -p "$HOME/.agents"
    if [ ! -e "$HOME/.agents/skills" ]; then
        ln -s "$TARGET_DIR/skills" "$HOME/.agents/skills"
    elif [ -L "$HOME/.agents/skills" ] && [ "$(readlink "$HOME/.agents/skills")" != "$TARGET_DIR/skills" ]; then
        ln -sf "$TARGET_DIR/skills" "$HOME/.agents/skills"
    fi

    # 4. Optional: Configure T3 Code with Pi as default engine
    echo ""
    echo ":: Step 4/4: T3 Code integration..."
    read -rp ":: Would you like to configure T3 Code to use Pi as its default agent engine? [Y/n]: " setup_t3 || setup_t3="n"
    setup_t3="${setup_t3:-Y}"

    if [[ "$setup_t3" =~ ^[Yy]$ ]]; then
        if ! command -v t3code &>/dev/null && ! command -v t3 &>/dev/null; then
            echo ":: T3 Code is not detected on your system."
            read -rp ":: Would you like to install T3 Code (Nightly) now? [Y/n]: " install_t3 || install_t3="n"
            install_t3="${install_t3:-Y}"
            if [[ "$install_t3" =~ ^[Yy]$ ]]; then
                if command -v yay &>/dev/null; then
                    echo ":: Installing T3 Code Nightly via AUR (yay)..."
                    yay -S --needed --noconfirm t3code-nightly-bin
                elif command -v brew &>/dev/null; then
                    echo ":: Installing T3 Code via Homebrew..."
                    brew install --cask t3-code
                else
                    echo ":: Downloading and running official T3 Code Nightly installer..."
                    curl -fsSL https://t3.codes/install.sh | T3CODE_CHANNEL=nightly sh
                fi
            fi
        else
            echo ":: T3 Code is already installed."
        fi

        echo ":: Configuring T3 Code settings (~/.t3/userdata)..."
        mkdir -p "$T3_USERDATA"
        T3_SOURCE=""
        if [ -d "$TARGET_DIR/t3" ]; then
            T3_SOURCE="$TARGET_DIR/t3"
        elif [ -d "$SCRIPT_DIR/t3" ]; then
            T3_SOURCE="$SCRIPT_DIR/t3"
        fi

        if [ -n "$T3_SOURCE" ]; then
            echo ":: Syncing custom T3 Code configuration into $T3_USERDATA..."
            for file in client-settings.json desktop-settings.json keybindings.json keybindings-migrations; do
                if [ -f "$T3_SOURCE/$file" ]; then
                    cp -u "$T3_SOURCE/$file" "$T3_USERDATA/" 2>/dev/null || cp "$T3_SOURCE/$file" "$T3_USERDATA/" 2>/dev/null || true
                fi
            done
            if [ -f "$T3_SOURCE/settings.json" ] && [ ! -f "$T3_USERDATA/settings.json" ]; then
                cp "$T3_SOURCE/settings.json" "$T3_USERDATA/"
            fi
        fi

        SETTINGS_FILE="$T3_USERDATA/settings.json"
        T3_SRC_SETTINGS="${T3_SOURCE:+$T3_SOURCE/settings.json}"

        node -e '
        const fs = require("fs");
        const targetPath = process.argv[1];
        const sourcePath = process.argv[2];
        let data = {};
        if (fs.existsSync(targetPath)) {
            try { data = JSON.parse(fs.readFileSync(targetPath, "utf8")); } catch (e) {}
        }
        if (sourcePath && fs.existsSync(sourcePath)) {
            try {
                const src = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
                if (src.favorites && (!data.favorites || data.favorites.length === 0)) {
                    data.favorites = src.favorites;
                }
                if (src.providerModelPreferences && !data.providerModelPreferences) {
                    data.providerModelPreferences = src.providerModelPreferences;
                }
            } catch (e) {}
        }
        data.defaultModelSelection = {
            instanceId: "pi",
            model: "antigravity/gemini-3.8-flash"
        };
        data.providerInstances = data.providerInstances || {};
        data.providerInstances.pi = {
            driver: "pi",
            displayName: "Pi",
            enabled: true
        };
        fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf8");
        console.log(":: Set Pi as default engine in " + targetPath);
        ' "$SETTINGS_FILE" "${T3_SRC_SETTINGS:-}"
    fi

    echo ""
    echo "=========================================================="
    echo "  ✨ Setup completed successfully!                        "
    echo "=========================================================="
    if [ ! -f "$TARGET_DIR/auth.json" ]; then
        echo ":: 🔑 Next step: Run 'pi' in your terminal and type '/login' to authenticate."
    else
        echo ":: 🔑 Credentials found. Pi is ready to use!"
    fi
}

# ========================================================
# CLI ARGUMENT DISPATCHER
# ========================================================
case "${1:-}" in
    --doctor|-d|doctor)
        run_doctor
        exit 0
        ;;
    --sync|-s|sync)
        shift
        run_sync "$@"
        exit 0
        ;;
    --install|-i|install)
        run_install
        exit 0
        ;;
    --uninstall|-u|uninstall)
        run_uninstall
        exit 0
        ;;
    --help|-h|help)
        echo "Usage: ./setup.sh [COMMAND]"
        echo ""
        echo "Commands:"
        echo "  (none)             Open interactive manager menu"
        echo "  -i, --install      Run full installation / update"
        echo "  -d, --doctor       Run system health check"
        echo "  -s, --sync         Sync live T3 Code settings into repo"
        echo "  -u, --uninstall    Completely remove Pi Agent and T3 Code"
        echo "  -h, --help         Show this help message"
        exit 0
        ;;
esac

# ========================================================
# INTERACTIVE MENU
# ========================================================
echo "=========================================================="
echo "  🚀 Pi Agent + T3 Code Universal Manager (Linux / macOS) "
echo "=========================================================="
echo ""
echo "Select an option:"
echo "  1) Install / Update (Pi Agent + T3 Code)"
echo "  2) Run Health Check (Doctor)"
echo "  3) Sync T3 Code Settings to Repo"
echo "  4) Uninstall Everything"
echo "  5) Exit"
echo ""
read -rp "Enter choice [1-5] (default: 1): " choice || choice="1"
choice="${choice:-1}"

case "$choice" in
    1) run_install ;;
    2) run_doctor ;;
    3) run_sync ;;
    4) run_uninstall ;;
    5) echo ":: Exiting." ; exit 0 ;;
    *) echo ":: Invalid choice." ; exit 1 ;;
esac
