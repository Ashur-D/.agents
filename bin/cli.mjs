#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readElectronLocalStorage } from "./leveldb-reader.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = path.resolve(__dirname, "..");
const HOME = os.homedir();
const IS_WIN = process.platform === "win32";

const c = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(HOME, p.slice(2));
  }
  return path.resolve(REPO_DIR, p);
}

function loadHarnessesConfig() {
  const file = path.join(REPO_DIR, "harnesses.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function getCommandPath(cmd) {
  try {
    const checker = IS_WIN ? `where ${cmd}` : `command -v ${cmd}`;
    const lines = execSync(checker, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (IS_WIN) {
      return lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) || lines[0] || null;
    }
    return lines[0] || null;
  } catch {
    return null;
  }
}

function commandExists(cmd) {
  return getCommandPath(cmd) !== null;
}

function runCmd(cmd, args = [], opts = {}) {
  let executable = cmd;
  let finalArgs = args;
  if (IS_WIN) {
    const resolved = getCommandPath(cmd) || cmd;
    if (/\.(cmd|bat)$/i.test(resolved)) {
      executable = process.env.ComSpec || "cmd.exe";
      finalArgs = ["/d", "/s", "/c", resolved, ...args];
    } else {
      executable = resolved;
    }
  }
  return spawnSync(executable, finalArgs, {
    stdio: opts.silent ? "pipe" : "inherit",
    shell: false,
    encoding: "utf8",
    ...opts,
  });
}

function isCmdOk(res) {
  return Boolean(res && !res.error && res.status === 0);
}

function ensureSymlink(targetPath, linkPath) {
  const parent = path.dirname(linkPath);
  fs.mkdirSync(parent, { recursive: true });

  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      if (path.resolve(path.dirname(linkPath), currentTarget) === path.resolve(targetPath)) {
        return "already-linked";
      }
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(linkPath);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const isDir = fs.statSync(targetPath).isDirectory();
  fs.symlinkSync(targetPath, linkPath, IS_WIN ? (isDir ? "junction" : "file") : undefined);
  return "linked";
}

async function ask(interactive, promptText, defaultVal = "") {
  if (!interactive) return defaultVal;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(promptText)).trim();
    return ans || defaultVal;
  } catch {
    return defaultVal;
  } finally {
    rl.close();
  }
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function countPhysicalRows(lines) {
  const cols = process.stdout.columns || 80;
  let total = 0;
  for (const line of lines) {
    const visibleLen = stripAnsi(line).length;
    total += Math.max(1, Math.ceil(visibleLen / cols));
  }
  return total;
}

async function ensureNpm(rl) {
  if (commandExists("npm")) return true;
  const ans = await ask(rl, ":: npm is not installed. Install Node.js / npm now? [Y/n]: ", "Y");
  if (!/^[Yy]/.test(ans)) {
    console.log(":: Skipping npm package installation (npm not installed).");
    return false;
  }
  if (IS_WIN) {
    runCmd("winget", ["install", "OpenJS.NodeJS.LTS", "--silent", "--accept-package-agreements", "--accept-source-agreements"]);
  } else if (commandExists("pacman")) {
    runCmd("sudo", ["pacman", "-S", "--needed", "--noconfirm", "nodejs", "npm"]);
  } else if (commandExists("apt-get")) {
    runCmd("sudo", ["apt-get", "update"]);
    runCmd("sudo", ["apt-get", "install", "-y", "nodejs", "npm"]);
  } else if (commandExists("dnf")) {
    runCmd("sudo", ["dnf", "install", "-y", "nodejs", "npm"]);
  } else if (commandExists("brew")) {
    runCmd("brew", ["install", "node"]);
  } else {
    console.warn(":: Could not detect package manager. Please install npm manually.");
    return false;
  }
  return commandExists("npm");
}

function configureNpmUserPrefix() {
  if (IS_WIN) return;
  const localBin = path.join(HOME, ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  runCmd("npm", ["config", "set", "prefix", path.join(HOME, ".local")]);
  if (!process.env.PATH?.includes(localBin)) {
    process.env.PATH = `${localBin}:${process.env.PATH}`;
  }
}

// ========================================================
// 1. T3 CODE (Auto-Installed by Default)
// ========================================================
export function isT3Installed() {
  return (
    commandExists("t3code") ||
    commandExists("t3") ||
    (IS_WIN &&
      (fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Programs", "t3code", "T3 Code.exe")) ||
        fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Programs", "t3code", "t3code.exe"))))
  );
}

export function setupT3({ autoInstall = true } = {}) {
  console.log(`\n${c.cyan}:: Step 1: T3 Code...${c.reset}`);

  if (!isT3Installed() && autoInstall) {
    console.log(":: T3 Code is not detected. Auto-installing T3 Code (Nightly)...");
    if (IS_WIN) {
      runCmd("powershell", [
        "-NoProfile",
        "-Command",
        "$env:T3CODE_CHANNEL='nightly'; Invoke-Expression \"& { $(Invoke-RestMethod 'https://t3.codes/install.ps1') }\"",
      ]);
    } else if (commandExists("yay")) {
      runCmd("yay", ["-S", "--needed", "--noconfirm", "t3code-nightly-bin"]);
    } else if (commandExists("brew")) {
      runCmd("brew", ["install", "--cask", "t3-code"]);
    } else {
      runCmd("sh", ["-c", "curl -fsSL https://t3.codes/install.sh | T3CODE_CHANNEL=nightly sh"]);
    }
  } else if (isT3Installed()) {
    console.log(`   ${c.green}[✓]${c.reset} T3 Code is installed`);
  }
}

const T3_SETTINGS_LOCAL_KEYS = new Set(["environmentIcon", "defaultThemeSetAt", "defaultAppearanceSetAt"]);
const T3_CLIENT_SETTINGS_LOCAL_KEYS = new Set([
  "voiceMicrophone",
  "voiceMicrophones",
  "onboardingCompletedAt",
  "browserProfiles",
  "browserDefaultProfileId",
  "sidebarProjectGroupingOverrides",
  "pullRequestMergeMethodOverrides",
]);
const T3_THEME_EXTENSIONS = new Set([".json", ".png", ".jpg", ".jpeg", ".webp"]);
const T3_BUILTIN_THEMES = new Set(["", "t3-code", "t3-chat", "grove", "ocean", "ember", "iris", "light", "dark", "system"]);
const T3_STOCK_THEME_IDS = new Set(["", "t3-code", "light", "dark", "system"]);
const T3_THEME_ID_RE = /^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$/;
const T3_THEME_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

function isSensitiveKey(key) {
  return /secret|token|password|apikey|api_key|credential/i.test(key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSyncableT3ThemeFile(name) {
  if (!name || name.startsWith(".") || /noctalia/i.test(name)) return false;
  return T3_THEME_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function getT3DesktopStorageDir(platform = process.platform, env = process.env, home = HOME) {
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "t3code-v2", "Local Storage", "leveldb");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "t3code-v2", "Local Storage", "leveldb");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "t3code-v2", "Local Storage", "leveldb");
}

export function resolveDesktopActiveTheme({ theme = "", appearanceMode = "", themeHalves = null } = {}) {
  let mode = appearanceMode === "light" || appearanceMode === "dark" || appearanceMode === "system" ? appearanceMode : "";
  let effectiveTheme = "";
  if (mode === "dark" && typeof themeHalves?.dark === "string" && themeHalves.dark) {
    effectiveTheme = themeHalves.dark;
  } else if (mode === "light" && typeof themeHalves?.light === "string" && themeHalves.light) {
    effectiveTheme = themeHalves.light;
  } else if (typeof theme === "string" && theme) {
    effectiveTheme = theme;
  } else if (typeof themeHalves?.dark === "string" && themeHalves.dark) {
    effectiveTheme = themeHalves.dark;
  } else if (typeof themeHalves?.light === "string" && themeHalves.light) {
    effectiveTheme = themeHalves.light;
  }

  if (!mode && (effectiveTheme === "dark" || effectiveTheme === "light" || effectiveTheme === "system")) {
    mode = effectiveTheme;
  }

  const defaultTheme = T3_STOCK_THEME_IDS.has(effectiveTheme) ? "" : effectiveTheme;
  return { themeId: effectiveTheme, defaultTheme, appearanceMode: mode };
}

export function toEnvironmentThemeFile(theme) {
  if (!isPlainObject(theme)) return null;
  const name = String(theme.name ?? theme.label ?? "").trim();
  const appearance = theme.appearance;
  if (!name || name.length > 48 || (appearance !== "light" && appearance !== "dark")) {
    return null;
  }
  const hasColors = isPlainObject(theme.colors) && Object.keys(theme.colors).length > 0;
  const hasCanvasAccent =
    typeof theme.canvas === "string" && theme.canvas.length > 0 && typeof theme.accent === "string" && theme.accent.length > 0;
  if (!hasColors && !hasCanvasAccent) {
    return null;
  }

  const out = {
    version: 1,
    name,
    appearance,
  };
  if (typeof theme.canvas === "string" && theme.canvas.length > 0) out.canvas = theme.canvas;
  if (typeof theme.accent === "string" && theme.accent.length > 0) out.accent = theme.accent;
  if (hasColors) out.colors = theme.colors;
  if (isPlainObject(theme.variants) && Object.keys(theme.variants).length > 0) {
    const variants = {};
    for (const mode of ["light", "dark"]) {
      if (isPlainObject(theme.variants[mode]) && Object.keys(theme.variants[mode]).length > 0) {
        variants[mode] = theme.variants[mode];
      }
    }
    if (Object.keys(variants).length > 0) out.variants = variants;
  }
  if (typeof theme.css === "string" && theme.css.length > 0) out.css = theme.css;
  return out;
}

export function readT3DesktopAppearance({ desktopStorageDir = getT3DesktopStorageDir() } = {}) {
  const store = readElectronLocalStorage(desktopStorageDir);
  if (!store) return null;

  const rawTheme = store.get("t3code:theme") ?? "";
  const rawMode = store.get("t3code:theme-appearance-mode") ?? "";
  let themeHalves = null;
  const rawHalves = store.get("t3code:theme-halves:v1");
  if (rawHalves) {
    try {
      const parsed = JSON.parse(rawHalves);
      if (isPlainObject(parsed)) themeHalves = parsed;
    } catch {}
  }

  const customThemesById = new Map();
  const rawThemes = store.get("t3code:themes:v1");
  if (rawThemes) {
    try {
      const parsed = JSON.parse(rawThemes);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isPlainObject(item) && typeof item.id === "string" && item.id) {
            customThemesById.set(item.id, item);
          }
        }
      }
    } catch {}
  }

  const { themeId, defaultTheme, appearanceMode } = resolveDesktopActiveTheme({
    theme: rawTheme,
    appearanceMode: rawMode,
    themeHalves,
  });
  if (!themeId && !appearanceMode) return null;

  const activeTheme = defaultTheme ? customThemesById.get(defaultTheme) || null : null;
  const themeFile = activeTheme ? toEnvironmentThemeFile(activeTheme) : null;
  return { themeId, defaultTheme, appearanceMode, themeFile, customThemesById };
}

export function getT3Paths(cfg = loadHarnessesConfig(), repoDir = REPO_DIR) {
  return {
    srcDir: path.join(repoDir, cfg.t3?.configDir || "configs/t3"),
    targetDir: expandHome(cfg.t3?.targetDir || "~/.t3/userdata"),
  };
}

export function sanitizeT3Settings(raw = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(raw)) {
    if (T3_SETTINGS_LOCAL_KEYS.has(key) || isSensitiveKey(key)) continue;
    if (key === "providerInstances") {
      if (!isPlainObject(value)) continue;
      const cleanInstances = {};
      for (const [id, inst] of Object.entries(value)) {
        if (!isPlainObject(inst)) continue;
        const cleanInst = {};
        if (inst.driver !== undefined) cleanInst.driver = inst.driver;
        if (inst.displayName !== undefined) cleanInst.displayName = inst.displayName;
        if (typeof inst.enabled === "boolean") cleanInst.enabled = inst.enabled;
        if (Array.isArray(inst.config?.customModels) && inst.config.customModels.length > 0) {
          cleanInst.config = { customModels: [...inst.config.customModels] };
        }
        cleanInstances[id] = cleanInst;
      }
      cleaned.providerInstances = cleanInstances;
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

export function mergeT3Settings(existing = {}, template = {}) {
  const merged = {
    ...existing,
    ...template,
  };
  if (template.defaultTheme !== undefined && template.defaultTheme !== existing.defaultTheme) {
    delete merged.defaultThemeSetAt;
  }
  if (template.defaultAppearance !== undefined && template.defaultAppearance !== existing.defaultAppearance) {
    delete merged.defaultAppearanceSetAt;
  }
  if (isPlainObject(existing.providerModelPreferences) || isPlainObject(template.providerModelPreferences)) {
    merged.providerModelPreferences = {
      ...(isPlainObject(existing.providerModelPreferences) ? existing.providerModelPreferences : {}),
      ...(isPlainObject(template.providerModelPreferences) ? template.providerModelPreferences : {}),
    };
  }
  if (isPlainObject(existing.providerInstances) || isPlainObject(template.providerInstances)) {
    const mergedInstances = {
      ...(isPlainObject(existing.providerInstances) ? existing.providerInstances : {}),
    };
    const templateInstances = isPlainObject(template.providerInstances) ? template.providerInstances : {};
    for (const [id, tplInst] of Object.entries(templateInstances)) {
      if (!isPlainObject(tplInst)) continue;
      const extInst = isPlainObject(existing.providerInstances?.[id]) ? existing.providerInstances[id] : {};
      const nextInst = {
        ...extInst,
        ...tplInst,
      };
      if (isPlainObject(extInst.config) || isPlainObject(tplInst.config)) {
        nextInst.config = {
          ...(isPlainObject(extInst.config) ? extInst.config : {}),
          ...(isPlainObject(tplInst.config) ? tplInst.config : {}),
        };
      }
      mergedInstances[id] = nextInst;
    }
    merged.providerInstances = mergedInstances;
  }
  return merged;
}

export function sanitizeT3ClientSettings(raw = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(raw)) {
    if (T3_CLIENT_SETTINGS_LOCAL_KEYS.has(key) || isSensitiveKey(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function mergeT3ClientSettings(existing = {}, template = {}) {
  return {
    ...existing,
    ...template,
  };
}

export function captureT3Config({ srcDir, targetDir, desktopStorageDir } = {}) {
  const defaults = getT3Paths();
  const resolvedSrc = srcDir || defaults.srcDir;
  const resolvedTarget = targetDir || defaults.targetDir;
  const captured = [];
  const themes = [];

  if (!fs.existsSync(resolvedTarget)) {
    return { captured, themes };
  }

  const desktopAppearance = desktopStorageDir === null ? null : readT3DesktopAppearance({ desktopStorageDir });
  let activeThemeId = desktopAppearance?.defaultTheme || "";

  const jsonSpecs = [
    { file: "settings.json", sanitize: sanitizeT3Settings, validate: isPlainObject },
    { file: "client-settings.json", sanitize: sanitizeT3ClientSettings, validate: isPlainObject },
    { file: "keybindings.json", sanitize: (v) => v, validate: Array.isArray },
  ];

  for (const { file, sanitize, validate } of jsonSpecs) {
    const srcFile = path.join(resolvedTarget, file);
    if (!fs.existsSync(srcFile)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(srcFile, "utf8"));
      if (!validate(parsed)) {
        console.warn(`  ${c.yellow}[!]${c.reset} Skipping ~/.t3/userdata/${file}: unexpected JSON shape`);
        continue;
      }
      fs.mkdirSync(resolvedSrc, { recursive: true });
      const output = sanitize(parsed);
      if (file === "settings.json") {
        if (desktopAppearance) {
          output.defaultTheme = desktopAppearance.defaultTheme;
          if (desktopAppearance.appearanceMode) {
            output.defaultAppearance = desktopAppearance.appearanceMode;
          }
          console.log(
            `  ${c.green}[✓]${c.reset} Synced active T3 Code appearance (${desktopAppearance.defaultTheme || "default"}, ${desktopAppearance.appearanceMode || "auto"}) from Desktop storage`
          );
        }
        activeThemeId = typeof output.defaultTheme === "string" ? output.defaultTheme : "";
      }
      fs.writeFileSync(path.join(resolvedSrc, file), JSON.stringify(output, null, 2) + "\n", "utf8");
      captured.push(file);
      console.log(`  ${c.green}[✓]${c.reset} Captured ~/.t3/userdata/${file}`);
    } catch (e) {
      console.warn(`  ${c.yellow}[!]${c.reset} Could not parse ~/.t3/userdata/${file}: ${e.message}`);
    }
  }

  const targetThemesDir = path.join(resolvedTarget, "themes");
  const srcThemesDir = path.join(resolvedSrc, "themes");
  const canSyncActiveTheme =
    Boolean(activeThemeId) &&
    !T3_BUILTIN_THEMES.has(activeThemeId) &&
    T3_THEME_ID_RE.test(activeThemeId) &&
    !/noctalia/i.test(activeThemeId);

  if (canSyncActiveTheme) {
    const themeFileName = `${activeThemeId}.json`;
    if (desktopAppearance?.themeFile && desktopAppearance.defaultTheme === activeThemeId) {
      fs.mkdirSync(srcThemesDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcThemesDir, themeFileName),
        JSON.stringify(desktopAppearance.themeFile, null, 2) + "\n",
        "utf8"
      );
      themes.push(themeFileName);
    } else {
      const targetThemeJson = path.join(targetThemesDir, themeFileName);
      if (fs.existsSync(targetThemeJson) && fs.statSync(targetThemeJson).isFile()) {
        fs.mkdirSync(srcThemesDir, { recursive: true });
        fs.copyFileSync(targetThemeJson, path.join(srcThemesDir, themeFileName));
        themes.push(themeFileName);
      }
    }

    if (fs.existsSync(targetThemesDir)) {
      for (const ext of T3_THEME_IMAGE_EXTENSIONS) {
        const imgName = `${activeThemeId}${ext}`;
        const imgSrc = path.join(targetThemesDir, imgName);
        if (fs.existsSync(imgSrc) && fs.statSync(imgSrc).isFile()) {
          fs.mkdirSync(srcThemesDir, { recursive: true });
          fs.copyFileSync(imgSrc, path.join(srcThemesDir, imgName));
          themes.push(imgName);
        }
      }
    }
  }

  let prunedCount = 0;
  if (fs.existsSync(srcThemesDir)) {
    const keepSet = new Set(themes);
    for (const entry of fs.readdirSync(srcThemesDir, { withFileTypes: true })) {
      if (entry.isFile() && !keepSet.has(entry.name)) {
        fs.unlinkSync(path.join(srcThemesDir, entry.name));
        prunedCount += 1;
      }
    }
  }

  if (themes.length > 0) {
    console.log(`  ${c.green}[✓]${c.reset} Captured ${themes.length} active T3 Code theme file(s)`);
  } else if (prunedCount > 0) {
    console.log(`  ${c.green}[✓]${c.reset} Synced T3 Code theme removals (${prunedCount} removed)`);
  }

  return { captured, themes };
}

export function applyT3Config({ srcDir, targetDir } = {}) {
  const defaults = getT3Paths();
  const resolvedSrc = srcDir || defaults.srcDir;
  const resolvedTarget = targetDir || defaults.targetDir;
  const applied = [];
  const themes = [];

  if (!fs.existsSync(resolvedSrc)) {
    return { applied, themes };
  }

  fs.mkdirSync(resolvedTarget, { recursive: true });

  const jsonMergeSpecs = [
    { file: "settings.json", merge: mergeT3Settings },
    { file: "client-settings.json", merge: mergeT3ClientSettings },
  ];

  for (const { file, merge } of jsonMergeSpecs) {
    const tplPath = path.join(resolvedSrc, file);
    if (!fs.existsSync(tplPath)) continue;

    let template;
    try {
      template = JSON.parse(fs.readFileSync(tplPath, "utf8"));
      if (!isPlainObject(template)) {
        console.warn(`   ${c.yellow}[!]${c.reset} Skipping T3 Code ${file} template: expected JSON object`);
        continue;
      }
    } catch (e) {
      console.warn(`   ${c.yellow}[!]${c.reset} Could not parse T3 Code ${file} template: ${e.message}`);
      continue;
    }

    const destPath = path.join(resolvedTarget, file);
    let existing = {};
    if (fs.existsSync(destPath)) {
      try {
        const parsedExisting = JSON.parse(fs.readFileSync(destPath, "utf8"));
        if (!isPlainObject(parsedExisting)) {
          console.warn(`   ${c.yellow}[!]${c.reset} Existing ~/.t3/userdata/${file} is not a JSON object; skipping overwrite`);
          continue;
        }
        existing = parsedExisting;
      } catch (e) {
        console.warn(`   ${c.yellow}[!]${c.reset} Could not parse existing ~/.t3/userdata/${file}: ${e.message}; skipping overwrite`);
        continue;
      }
    }

    const merged = merge(existing, template);
    fs.writeFileSync(destPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    applied.push(file);
    console.log(`   ${c.green}[✓]${c.reset} Applied T3 Code ${file}`);
  }

  const keybindingsSrc = path.join(resolvedSrc, "keybindings.json");
  if (fs.existsSync(keybindingsSrc)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keybindingsSrc, "utf8"));
      if (!Array.isArray(parsed)) {
        console.warn(`   ${c.yellow}[!]${c.reset} Skipping T3 Code keybindings.json: expected JSON array`);
      } else {
        fs.writeFileSync(path.join(resolvedTarget, "keybindings.json"), JSON.stringify(parsed, null, 2) + "\n", "utf8");
        applied.push("keybindings.json");
        console.log(`   ${c.green}[✓]${c.reset} Applied T3 Code keybindings.json`);
      }
    } catch (e) {
      console.warn(`   ${c.yellow}[!]${c.reset} Could not parse T3 Code keybindings.json: ${e.message}`);
    }
  }

  const srcThemesDir = path.join(resolvedSrc, "themes");
  if (fs.existsSync(srcThemesDir)) {
    const syncableThemes = fs
      .readdirSync(srcThemesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSyncableT3ThemeFile(entry.name))
      .map((entry) => entry.name);

    if (syncableThemes.length > 0) {
      const destThemesDir = path.join(resolvedTarget, "themes");
      fs.mkdirSync(destThemesDir, { recursive: true });
      for (const name of syncableThemes) {
        fs.copyFileSync(path.join(srcThemesDir, name), path.join(destThemesDir, name));
        themes.push(name);
      }
      console.log(`   ${c.green}[✓]${c.reset} Applied ${themes.length} T3 Code theme file(s)`);
    }
  }

  return { applied, themes };
}

export function enableT3Provider(t3Provider, { targetDir = getT3Paths().targetDir, preserveExistingEnabled = false } = {}) {
  if (!t3Provider?.id) return;
  fs.mkdirSync(targetDir, { recursive: true });
  const settingsDest = path.join(targetDir, "settings.json");
  let existing = {};
  if (fs.existsSync(settingsDest)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsDest, "utf8"));
    } catch {}
  }
  existing.providerInstances = existing.providerInstances || {};
  const current = existing.providerInstances[t3Provider.id] || {};
  const enabled = preserveExistingEnabled && typeof current.enabled === "boolean" ? current.enabled : true;
  existing.providerInstances[t3Provider.id] = {
    ...current,
    driver: t3Provider.driver || t3Provider.id,
    ...(t3Provider.displayName ? { displayName: t3Provider.displayName } : {}),
    enabled,
    ...(t3Provider.config ? { config: t3Provider.config } : {}),
  };
  fs.writeFileSync(settingsDest, JSON.stringify(existing, null, 2) + "\n", "utf8");
  console.log(
    `   ${c.green}[✓]${c.reset} ${enabled ? "Enabled" : "Configured"} ${t3Provider.displayName || t3Provider.id} provider in T3 Code`
  );
}

const AGY_USER_SETTINGS_LOCAL_KEYS = new Set(["remoteControlHostname"]);

export function getAgyPaths(cfg = loadHarnessesConfig(), repoDir = REPO_DIR) {
  const agy = cfg.harnesses?.agy || {};
  return {
    srcDir: path.join(repoDir, agy.configDir || "configs/agy"),
    targetFile: expandHome(agy.configTarget || "~/.gemini/config/config.json"),
  };
}

export function sanitizeAgyConfig(raw = {}) {
  const cleaned = {};
  if (isPlainObject(raw.userSettings)) {
    const cleanUserSettings = {};
    for (const [key, value] of Object.entries(raw.userSettings)) {
      if (AGY_USER_SETTINGS_LOCAL_KEYS.has(key) || isSensitiveKey(key)) continue;
      cleanUserSettings[key] = value;
    }
    cleaned.userSettings = cleanUserSettings;
  }
  return cleaned;
}

export function mergeAgyConfig(existing = {}, template = {}) {
  const merged = { ...existing };
  if (isPlainObject(existing.userSettings) || isPlainObject(template.userSettings)) {
    merged.userSettings = {
      ...(isPlainObject(existing.userSettings) ? existing.userSettings : {}),
      ...(isPlainObject(template.userSettings) ? template.userSettings : {}),
    };
  }
  return merged;
}

export function captureAgyConfig({ srcDir, targetFile } = {}) {
  const defaults = getAgyPaths();
  const resolvedSrc = srcDir || defaults.srcDir;
  const resolvedTarget = targetFile || defaults.targetFile;

  if (!fs.existsSync(resolvedTarget)) {
    return { captured: false };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedTarget, "utf8"));
    if (!isPlainObject(parsed)) {
      console.warn(`  ${c.yellow}[!]${c.reset} Skipping ~/.gemini/config/config.json: expected JSON object`);
      return { captured: false };
    }
    const sanitized = sanitizeAgyConfig(parsed);
    fs.mkdirSync(resolvedSrc, { recursive: true });
    fs.writeFileSync(path.join(resolvedSrc, "config.json"), JSON.stringify(sanitized, null, 2) + "\n", "utf8");
    console.log(`  ${c.green}[✓]${c.reset} Captured ~/.gemini/config/config.json (userSettings)`);
    return { captured: true };
  } catch (e) {
    console.warn(`  ${c.yellow}[!]${c.reset} Could not parse ~/.gemini/config/config.json: ${e.message}`);
    return { captured: false };
  }
}

export function applyAgyConfig({ srcDir, targetFile } = {}) {
  const defaults = getAgyPaths();
  const resolvedSrc = srcDir || defaults.srcDir;
  const resolvedTarget = targetFile || defaults.targetFile;
  const tplPath = path.join(resolvedSrc, "config.json");

  if (!fs.existsSync(tplPath)) {
    return { applied: false };
  }

  let template;
  try {
    template = JSON.parse(fs.readFileSync(tplPath, "utf8"));
    if (!isPlainObject(template)) {
      console.warn(`   ${c.yellow}[!]${c.reset} Skipping Antigravity config.json template: expected JSON object`);
      return { applied: false };
    }
  } catch (e) {
    console.warn(`   ${c.yellow}[!]${c.reset} Could not parse Antigravity config.json template: ${e.message}`);
    return { applied: false };
  }

  let existing = {};
  if (fs.existsSync(resolvedTarget)) {
    try {
      const parsedExisting = JSON.parse(fs.readFileSync(resolvedTarget, "utf8"));
      if (!isPlainObject(parsedExisting)) {
        console.warn(`   ${c.yellow}[!]${c.reset} Existing ~/.gemini/config/config.json is not a JSON object; skipping overwrite`);
        return { applied: false };
      }
      existing = parsedExisting;
    } catch (e) {
      console.warn(`   ${c.yellow}[!]${c.reset} Could not parse existing ~/.gemini/config/config.json: ${e.message}; skipping overwrite`);
      return { applied: false };
    }
  }

  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  const merged = mergeAgyConfig(existing, template);
  fs.writeFileSync(resolvedTarget, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`   ${c.green}[✓]${c.reset} Applied Antigravity config.json (userSettings)`);
  return { applied: true };
}

// ========================================================
// 2. SKILLS & HARNESS CONFIGURATION
// ========================================================
export function configureHarnessSkills(id, h, canonicalRoot, canonicalSkills) {
  if (h.skillsMode === "native") {
    console.log(`   ${c.green}[✓]${c.reset} ${h.name}: natively scans ${canonicalRoot} (0 symlinks)`);
  } else if (h.skillsMode === "config" && h.configFile) {
    const cfgPath = expandHome(h.configFile);
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    let existing = {};
    if (fs.existsSync(cfgPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      } catch {}
    }
    const skillsArr = Array.isArray(existing.skills) ? existing.skills : [];
    if (!skillsArr.includes(canonicalRoot) && !skillsArr.includes(canonicalSkills)) {
      skillsArr.push(canonicalRoot);
    }
    existing.skills = skillsArr;
    fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    console.log(`   ${c.green}[✓]${c.reset} ${h.name}: configured skills=[${canonicalRoot}] in ${h.configFile} (0 symlinks)`);
  } else if (h.skillsPath) {
    const dest = expandHome(h.skillsPath);
    ensureSymlink(canonicalSkills, dest);
    console.log(`   ${c.green}[✓]${c.reset} ${h.name}: linked ${h.skillsPath} -> ${canonicalRoot}`);
  }
}

export function ensureCanonicalSkillsRoot(cfg = loadHarnessesConfig(), repoDir = REPO_DIR) {
  const repoSkills = path.join(repoDir, "skills");
  const canonicalRoot = cfg.skillsRoot || "~/.agents/skills";
  const canonicalSkills = expandHome(canonicalRoot);

  if (path.resolve(canonicalSkills) !== path.resolve(repoSkills)) {
    ensureSymlink(repoSkills, canonicalSkills);
    console.log(`   ${c.green}[✓]${c.reset} ${canonicalRoot} -> ${repoSkills}`);
  } else {
    console.log(`   ${c.green}[✓]${c.reset} Canonical directory ready: ${canonicalSkills}`);
  }

  return { repoSkills, canonicalRoot, canonicalSkills };
}

export function mergePiSettings(existing = {}, template = {}) {
  const merged = {
    ...existing,
    ...template,
  };
  if (Array.isArray(template.packages)) {
    merged.packages = [...new Set(template.packages)];
  }
  return merged;
}

export function linkAllSkills(selectedHarnesses = null) {
  const cfg = loadHarnessesConfig();
  const canonicalRoot = cfg.skillsRoot || "~/.agents/skills";

  console.log(`\n${c.cyan}:: Configuring Universal Agent Skills (${canonicalRoot})...${c.reset}`);
  const { canonicalSkills } = ensureCanonicalSkillsRoot(cfg);

  for (const [id, h] of Object.entries(cfg.harnesses)) {
    if (selectedHarnesses && !selectedHarnesses.has(id)) continue;
    configureHarnessSkills(id, h, canonicalRoot, canonicalSkills);
  }
}

export async function setupPi({ installCli = true, rl = null } = {}) {
  const cfg = loadHarnessesConfig();
  const piCfg = cfg.harnesses.pi;
  const targetDir = expandHome(piCfg.targetDir || "~/.pi/agent");
  const srcDir = path.join(REPO_DIR, piCfg.configDir || "configs/pi");

  if (installCli && (await ensureNpm(rl))) {
    configureNpmUserPrefix();
    console.log(":: Installing / updating @earendil-works/pi-coding-agent...");
    runCmd("npm", ["install", "-g", "@earendil-works/pi-coding-agent"]);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // Remove legacy ~/.pi/agent/skills symlink if present so Pi doesn't double-scan ~/.agents/skills
  const legacyPiSkills = path.join(targetDir, "skills");
  try {
    if (fs.lstatSync(legacyPiSkills).isSymbolicLink()) {
      fs.unlinkSync(legacyPiSkills);
    }
  } catch {}

  const zentuiSrc = path.join(srcDir, "zentui.json");
  if (fs.existsSync(zentuiSrc)) {
    ensureSymlink(zentuiSrc, path.join(targetDir, "zentui.json"));
    console.log(`   ${c.green}[✓]${c.reset} Linked zentui.json`);
  }

  const extSrcDir = path.join(srcDir, "extensions");
  const extDestDir = path.join(targetDir, "extensions");
  fs.mkdirSync(extDestDir, { recursive: true });
  if (fs.existsSync(extSrcDir)) {
    for (const entry of fs.readdirSync(extSrcDir)) {
      ensureSymlink(path.join(extSrcDir, entry), path.join(extDestDir, entry));
      console.log(`   ${c.green}[✓]${c.reset} Linked extension: ${entry}`);
    }
  }

  const settingsTemplatePath = path.join(srcDir, "settings.json");
  const settingsDest = path.join(targetDir, "settings.json");
  if (fs.existsSync(settingsTemplatePath)) {
    const template = JSON.parse(fs.readFileSync(settingsTemplatePath, "utf8"));
    let existing = {};
    if (fs.existsSync(settingsDest)) {
      try {
        existing = JSON.parse(fs.readFileSync(settingsDest, "utf8"));
      } catch {}
    }
    const merged = mergePiSettings(existing, template);
    fs.writeFileSync(settingsDest, JSON.stringify(merged, null, 2) + "\n", "utf8");
    console.log(`   ${c.green}[✓]${c.reset} Applied Pi settings.json template`);
  }

  if (installCli && commandExists("pi")) {
    console.log(":: Updating declared Pi extensions...");
    runCmd("pi", ["update", "--extensions"], { cwd: targetDir });
  }
}

export async function setupHarness(id, h, { installCli = true, rl = null, configureT3 = true } = {}) {
  const cfg = loadHarnessesConfig();
  const canonicalRoot = cfg.skillsRoot || "~/.agents/skills";
  const canonicalSkills = expandHome(canonicalRoot);

  console.log(`\n${c.cyan}:: Setting up ${h.name}...${c.reset}`);

  if (id === "pi") {
    await setupPi({ installCli, rl });
  } else if (installCli) {
    const bins = Array.isArray(h.bin) ? h.bin : h.bin ? [h.bin] : [];
    const isInstalled = bins.some(commandExists);
    if (!isInstalled && bins.length > 0) {
      let installedViaYay = false;
      if (!IS_WIN && commandExists("yay")) {
        const pkgsToTry = [h.aurPackage, h.aurFallback].filter(Boolean);
        for (const pkg of pkgsToTry) {
          console.log(`:: Installing ${h.name} via yay (${pkg})...`);
          const res = runCmd("yay", ["-S", "--needed", "--noconfirm", pkg]);
          if (res.status === 0) {
            installedViaYay = true;
            break;
          }
          console.log(`:: yay install of ${pkg} failed, checking alternatives...`);
        }
      }
      if (!installedViaYay && h.installScript && !IS_WIN) {
        console.log(`:: Installing ${h.name} via official install script...`);
        runCmd("bash", ["-c", h.installScript]);
      } else if (!installedViaYay && h.winInstallScript && IS_WIN) {
        console.log(`:: Installing ${h.name} via official PowerShell install script...`);
        runCmd("powershell", ["-NoProfile", "-Command", h.winInstallScript]);
      } else if (!installedViaYay && h.npmPackage && (await ensureNpm(rl))) {
        configureNpmUserPrefix();
        console.log(`:: Installing ${h.name} via npm (${h.npmPackage})...`);
        runCmd("npm", ["install", "-g", h.npmPackage]);
      }
    }
  }

  configureHarnessSkills(id, h, canonicalRoot, canonicalSkills);
  if (id === "agy") {
    applyAgyConfig();
  }
  if (configureT3 && h.t3Provider) {
    enableT3Provider(h.t3Provider, { preserveExistingEnabled: !installCli });
  }
}

// ========================================================
// 3. GLOBAL CLI WRAPPER (~/.local/bin/agents)
// ========================================================
export function installGlobalBinWrappers() {
  const cliPath = path.join(REPO_DIR, "bin", "cli.mjs");
  if (IS_WIN) {
    const npmBin = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "npm");
    fs.mkdirSync(npmBin, { recursive: true });
    fs.writeFileSync(path.join(npmBin, "agents.cmd"), `@echo off\r\nnode "${cliPath}" %*\r\n`, "utf8");
    fs.writeFileSync(path.join(npmBin, "agents.ps1"), `#!/usr/bin/env pwsh\r\nnode "${cliPath}" @args\r\n`, "utf8");
    console.log(`\n${c.cyan}:: Installed CLI in ${npmBin}:${c.reset} agents`);
    return;
  }
  const localBin = path.join(HOME, ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });

  const agentBin = path.join(localBin, "agents");
  fs.writeFileSync(agentBin, `#!/usr/bin/env bash\nset -euo pipefail\nexec node "${cliPath}" "$@"\n`, { mode: 0o755 });
  console.log(`\n${c.cyan}:: Installed CLI in ~/.local/bin:${c.reset} agents`);
}

// ========================================================
// 4. HEALTH CHECK (DOCTOR)
// ========================================================
export function runDoctor() {
  const cfg = loadHarnessesConfig();
  const canonicalRoot = cfg.skillsRoot || "~/.agents/skills";
  const canonicalSkills = expandHome(canonicalRoot);
  const repoSkills = path.join(REPO_DIR, "skills");

  console.log("\n==========================================================");
  console.log("  🩺 System Health Check (Doctor)                         ");
  console.log("==========================================================\n");

  console.log(`${c.bold}Core Dependencies:${c.reset}`);
  for (const cmd of ["node", "npm", "git", "rg", "fd"]) {
    const bin = getCommandPath(cmd);
    if (bin) {
      console.log(`  ${c.green}[✓]${c.reset} ${cmd}: ${bin}`);
    } else {
      console.log(`  ${c.yellow}[!]${c.reset} ${cmd}: Not found`);
    }
  }

  const t3Bin = getCommandPath("t3code") || getCommandPath("t3");
  console.log(`  ${t3Bin ? `${c.green}[✓]${c.reset} t3code: ${t3Bin}` : `${c.yellow}[!]${c.reset} t3code: Not found`}`);

  const skillCount = fs.existsSync(repoSkills)
    ? fs.readdirSync(repoSkills, { withFileTypes: true }).filter((d) => d.isDirectory()).length
    : 0;
  console.log(`\n${c.bold}Repository & Canonical Skills:${c.reset}`);
  console.log(`  ${c.green}[✓]${c.reset} Repo Root:   ${REPO_DIR}`);
  console.log(`  ${c.green}[✓]${c.reset} Skills Root: ${canonicalSkills} (${skillCount} skills)`);

  console.log(`\n${c.bold}Registered Harnesses (from harnesses.json):${c.reset}`);
  for (const h of Object.values(cfg.harnesses)) {
    const bins = Array.isArray(h.bin) ? h.bin : h.bin ? [h.bin] : [];
    const foundBin = bins.map(getCommandPath).find(Boolean);
    const binStatus =
      bins.length === 0
        ? ""
        : foundBin
          ? `${c.green}installed (${foundBin})${c.reset}`
          : `${c.yellow}CLI not on PATH${c.reset}`;

    let skillStatus = "";
    if (h.skillsMode === "native") {
      skillStatus = `${c.green}native scan (${canonicalRoot})${c.reset}`;
    } else if (h.skillsMode === "config" && h.configFile) {
      const cfgPath = expandHome(h.configFile);
      let hasSkillCfg = false;
      if (fs.existsSync(cfgPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          hasSkillCfg =
            Array.isArray(parsed.skills) &&
            (parsed.skills.includes(canonicalRoot) || parsed.skills.includes(canonicalSkills));
        } catch {}
      }
      skillStatus = hasSkillCfg
        ? `${c.green}configured in ${h.configFile}${c.reset}`
        : `${c.yellow}not configured in ${h.configFile}${c.reset}`;
    } else if (h.skillsPath) {
      const sp = expandHome(h.skillsPath);
      try {
        const lstat = fs.lstatSync(sp);
        const real = fs.realpathSync(sp);
        if (lstat.isSymbolicLink() && real === fs.realpathSync(repoSkills)) {
          skillStatus = `${c.green}symlinked (${h.skillsPath} -> ${canonicalRoot})${c.reset}`;
        } else {
          skillStatus = `${c.yellow}exists but not linked to ${canonicalRoot}${c.reset}`;
        }
      } catch {
        skillStatus = `${c.red}not linked (${h.skillsPath})${c.reset}`;
      }
    }

    const parts = [binStatus, skillStatus].filter(Boolean).join(" | ");
    console.log(`  ${c.green}[•]${c.reset} ${h.name.padEnd(24)} ${parts}`);
  }

  const { srcDir: t3SrcDir, targetDir: t3TargetDir } = getT3Paths(cfg);
  const t3Files = ["settings.json", "client-settings.json", "keybindings.json"];
  console.log(`\n${c.bold}T3 Code Config:${c.reset}`);
  console.log(`  ${c.green}[✓]${c.reset} Synced Source: ${t3SrcDir}`);
  console.log(`  ${c.green}[✓]${c.reset} Userdata Dir:  ${t3TargetDir}`);
  for (const file of t3Files) {
    const hasSrc = fs.existsSync(path.join(t3SrcDir, file));
    const hasDest = fs.existsSync(path.join(t3TargetDir, file));
    const status =
      hasSrc && hasDest
        ? `${c.green}synced & applied${c.reset}`
        : hasSrc
          ? `${c.yellow}in repo only (run agents apply)${c.reset}`
          : hasDest
            ? `${c.yellow}local only (run agents sync)${c.reset}`
            : `${c.yellow}not present${c.reset}`;
    console.log(`  ${hasSrc && hasDest ? `${c.green}[✓]${c.reset}` : `${c.yellow}[!]${c.reset}`} ${file.padEnd(22)} ${status}`);
  }
  const srcThemeCount = fs.existsSync(path.join(t3SrcDir, "themes"))
    ? fs.readdirSync(path.join(t3SrcDir, "themes"), { withFileTypes: true }).filter((d) => d.isFile() && isSyncableT3ThemeFile(d.name)).length
    : 0;
  const destThemeCount = fs.existsSync(path.join(t3TargetDir, "themes"))
    ? fs.readdirSync(path.join(t3TargetDir, "themes"), { withFileTypes: true }).filter((d) => d.isFile() && isSyncableT3ThemeFile(d.name)).length
    : 0;
  let activeThemeLabel = "not set";
  const syncedSettingsPath = path.join(t3SrcDir, "settings.json");
  if (fs.existsSync(syncedSettingsPath)) {
    try {
      const syncedSettings = JSON.parse(fs.readFileSync(syncedSettingsPath, "utf8"));
      const tName = syncedSettings.defaultTheme || "default";
      const tMode = syncedSettings.defaultAppearance || "auto";
      activeThemeLabel = `${tName} (${tMode})`;
    } catch {}
  }
  console.log(`  ${c.green}[•]${c.reset} ${"active theme:".padEnd(22)} ${activeThemeLabel}`);
  console.log(`  ${c.green}[•]${c.reset} ${"themes/".padEnd(22)} repo: ${srcThemeCount}, local: ${destThemeCount}`);

  const { srcDir: agySrcDir, targetFile: agyTargetFile } = getAgyPaths(cfg);
  const hasAgySrc = fs.existsSync(path.join(agySrcDir, "config.json"));
  const hasAgyDest = fs.existsSync(agyTargetFile);
  const agyCfgStatus =
    hasAgySrc && hasAgyDest
      ? `${c.green}synced & applied${c.reset}`
      : hasAgySrc
        ? `${c.yellow}in repo only (run agents apply)${c.reset}`
        : hasAgyDest
          ? `${c.yellow}local only (run agents sync)${c.reset}`
          : `${c.yellow}not present${c.reset}`;
  console.log(`\n${c.bold}Antigravity Config:${c.reset}`);
  console.log(`  ${hasAgySrc && hasAgyDest ? `${c.green}[✓]${c.reset}` : `${c.yellow}[!]${c.reset}`} ${"config.json".padEnd(22)} ${agyCfgStatus}`);

  console.log("\n==========================================================\n");
}

// ========================================================
// 5. SYNC (Capture Pi, T3 & Agy Configs & Push Skills to GitHub)
// ========================================================
export async function runSync(args = [], rl = null) {
  console.log("\n==========================================================");
  console.log("  🔄 Sync Skills, Pi, T3 & Agy Configs to GitHub          ");
  console.log("==========================================================\n");

  let autoPush = args.includes("--push") || args.includes("-p");
  const msgIdx = args.findIndex((a) => a === "-m" || a === "--message");
  let customMsg = msgIdx !== -1 && args[msgIdx + 1] ? args[msgIdx + 1] : null;

  const cfg = loadHarnessesConfig();
  const piCfg = cfg.harnesses.pi;
  const piTarget = expandHome(piCfg?.targetDir || "~/.pi/agent");
  const piSrc = path.join(REPO_DIR, piCfg?.configDir || "configs/pi");

  if (fs.existsSync(path.join(piTarget, "settings.json"))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(piTarget, "settings.json"), "utf8"));
      delete data.defaultProvider;
      delete data.defaultModel;
      delete data.defaultThinkingLevel;
      delete data.lastChangelogVersion;
      data.theme = "system";
      fs.mkdirSync(piSrc, { recursive: true });
      fs.writeFileSync(path.join(piSrc, "settings.json"), JSON.stringify(data, null, 2) + "\n", "utf8");
      console.log(`  ${c.green}[✓]${c.reset} Captured ~/.pi/agent/settings.json`);
    } catch (e) {
      console.warn(`  ${c.yellow}[!]${c.reset} Could not parse ~/.pi/agent/settings.json: ${e.message}`);
    }
  }

  captureT3Config();
  captureAgyConfig();

  const statusRes = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_DIR, encoding: "utf8" });
  if (!isCmdOk(statusRes)) {
    console.error(`\n${c.red}[✗] Failed to check git status in ${REPO_DIR}.${c.reset}\n`);
    process.exitCode = 1;
    return;
  }
  const statusOut = (statusRes.stdout || "").trim();
  if (!statusOut) {
    console.log(`\n${c.green}✨ Everything is clean and up-to-date. Nothing to commit.${c.reset}\n`);
    return;
  }

  console.log("\n:: Changes detected in ~/.agents:");
  runCmd("git", ["status", "-s"], { cwd: REPO_DIR });

  if (!customMsg) {
    const now = new Date().toISOString().replace("T", " ").slice(0, 16);
    const defaultMsg = `chore: sync skills & config (${now})`;
    if (autoPush) {
      customMsg = defaultMsg;
    } else {
      customMsg = await ask(rl, `\nCommit message [${defaultMsg}]: `, defaultMsg);
    }
  }

  if (!isCmdOk(runCmd("git", ["add", "-A"], { cwd: REPO_DIR }))) {
    console.error(`\n${c.red}[✗] git add failed.${c.reset}\n`);
    process.exitCode = 1;
    return;
  }
  if (!isCmdOk(runCmd("git", ["commit", "-m", customMsg], { cwd: REPO_DIR }))) {
    console.error(`\n${c.red}[✗] git commit failed.${c.reset}\n`);
    process.exitCode = 1;
    return;
  }

  if (!autoPush) {
    const ans = await ask(rl, "\n:: Push changes to GitHub now? [Y/n]: ", "Y");
    autoPush = /^[Yy]/.test(ans);
  }

  if (autoPush) {
    console.log(":: Pulling latest with rebase & pushing to origin...");
    if (!isCmdOk(runCmd("git", ["pull", "--rebase", "--autostash"], { cwd: REPO_DIR }))) {
      console.error(`\n${c.red}[✗] git pull --rebase failed. Resolve conflicts and push manually.${c.reset}\n`);
      process.exitCode = 1;
      return;
    }
    if (!isCmdOk(runCmd("git", ["push"], { cwd: REPO_DIR }))) {
      console.error(`\n${c.red}[✗] git push failed.${c.reset}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n${c.green}✨ Successfully synced and pushed to GitHub!${c.reset}\n`);
  }
}

// ========================================================
// 6. UPDATE
// ========================================================
export async function runUpdate(rl = null) {
  console.log("\n==========================================================");
  console.log("  ⬆️  Updating ~/.agents, Pi CLI & Extensions             ");
  console.log("==========================================================\n");

  console.log(":: 1/3 Pulling latest ~/.agents repository...");
  if (!isCmdOk(runCmd("git", ["pull", "--rebase", "--autostash"], { cwd: REPO_DIR }))) {
    console.error(`\n${c.red}[✗] git pull --rebase failed. Resolve conflicts before updating.${c.reset}\n`);
    process.exitCode = 1;
    return;
  }

  if (await ensureNpm(rl)) {
    configureNpmUserPrefix();
    console.log("\n:: 2/3 Updating @earendil-works/pi-coding-agent...");
    runCmd("npm", ["install", "-g", "@earendil-works/pi-coding-agent"]);
  }

  const cfg = loadHarnessesConfig();
  const piTarget = expandHome(cfg.harnesses.pi?.targetDir || "~/.pi/agent");
  if (commandExists("pi") && fs.existsSync(piTarget)) {
    console.log("\n:: 3/3 Updating Pi extensions...");
    runCmd("pi", ["update", "--extensions"], { cwd: piTarget });
  }

  linkAllSkills();
  console.log(`\n${c.green}✨ Update complete!${c.reset}`);
}

// ========================================================
// 7. INSTALL / APPLY FLOW
// ========================================================
export function parseHarnessSelection(raw, entries) {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "a" || normalized === "all" || normalized === "*") {
    return new Set(entries.map(([id]) => id));
  }
  if (normalized === "n" || normalized === "none" || normalized === "0") {
    return new Set();
  }
  const chosen = new Set();
  for (const token of normalized.split(/[\s,]+/).filter(Boolean)) {
    const num = Number(token);
    if (Number.isInteger(num) && num >= 1 && num <= entries.length) {
      chosen.add(entries[num - 1][0]);
    } else if (entries.some(([id]) => id.toLowerCase() === token)) {
      chosen.add(entries.find(([id]) => id.toLowerCase() === token)[0]);
    }
  }
  return chosen;
}

async function promptHarnessMenu(entries, interactive) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\n${c.bold}Select harnesses to install & configure:${c.reset}`);
    entries.forEach(([id, h], idx) => {
      const bins = Array.isArray(h.bin) ? h.bin : h.bin ? [h.bin] : [];
      const installed = bins.some(commandExists);
      const badge = bins.length === 0 ? "" : installed ? ` ${c.green}(installed)${c.reset}` : ` ${c.yellow}(not installed)${c.reset}`;
      console.log(`  ${idx + 1}) ${h.name.padEnd(24)} [${id}]${badge}`);
    });
    console.log(`  a) All harnesses (default)`);
    console.log(`  n) None (skip harnesses)\n`);
    const raw = await ask(interactive, `Enter choices (e.g. 1,3 or pi,agy or a for all) [a]: `, "a");
    return parseHarnessSelection(raw, entries);
  }

  // Interactive arrow-key + spacebar checkbox menu
  const selected = new Set(entries.map(([id]) => id));
  let cursor = 0;
  let renderedRows = 0;

  const badges = entries.map(([, h]) => {
    const bins = Array.isArray(h.bin) ? h.bin : h.bin ? [h.bin] : [];
    const installed = bins.some(commandExists);
    return bins.length === 0 ? "" : installed ? ` ${c.green}(installed)${c.reset}` : ` ${c.yellow}(not installed)${c.reset}`;
  });

  const render = () => {
    if (renderedRows > 0) {
      process.stdout.write(`\r\x1b[${renderedRows}A\r\x1b[0J`);
    }
    const lines = [
      `${c.bold}Select harnesses to install & configure:${c.reset}`,
      `${c.cyan}(↑/↓ move, Space toggle, a all, n none, Enter confirm)${c.reset}`,
      ...entries.map(([id, h], idx) => {
        const active = idx === cursor;
        const checked = selected.has(id);
        const pointer = active ? `${c.cyan}❯${c.reset}` : " ";
        const box = checked ? `${c.green}[✓]${c.reset}` : "[ ]";
        const label = active ? `${c.bold}${h.name.padEnd(24)}${c.reset}` : h.name.padEnd(24);
        return ` ${pointer} ${box} ${label} [${id}]${badges[idx]}`;
      }),
    ];
    process.stdout.write(lines.join("\n") + "\n");
    renderedRows = countPhysicalRows(lines);
  };

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdout.write("\x1b[?25l");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render();

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + entries.length) % entries.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % entries.length;
        render();
      } else if (key.name === "space") {
        const id = entries[cursor][0];
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        render();
      } else if (str === "a" || str === "A") {
        if (selected.size === entries.length) selected.clear();
        else entries.forEach(([id]) => selected.add(id));
        render();
      } else if (str === "n" || str === "N") {
        selected.clear();
        render();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(selected);
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

export function resolveInstallProfile(choice) {
  const normalized = String(choice || "").trim().toLowerCase();
  if (normalized === "2" || normalized === "agy" || normalized === "antigravity") {
    return ["agy"];
  }
  if (normalized === "3" || normalized === "t3" || normalized === "t3code") {
    return ["t3", "skills"];
  }
  return null;
}

export async function runInstall({ only = null, rl = null, applyOnly = false } = {}) {
  const cfg = loadHarnessesConfig();
  const entries = Object.entries(cfg.harnesses);
  let resolvedOnly = only;

  if (!resolvedOnly && !applyOnly && rl) {
    const profileChoice = await promptActionMenu(
      [
        { id: "1", label: "T3 Code + Harnesses", hint: "(t3code + choose pi/opencode/agy)" },
        { id: "2", label: "Antigravity (agy) only", hint: "(install agy + skills + config.json)" },
        { id: "3", label: "T3 Code only", hint: "(install t3code + link skills)" },
      ],
      rl
    );
    resolvedOnly = resolveInstallProfile(profileChoice);
  }

  const explicitSet = resolvedOnly ? new Set(resolvedOnly.map((m) => m.trim().toLowerCase())) : null;
  const shouldConfigureT3 = !explicitSet || explicitSet.has("t3");

  // 1. Auto-install & configure T3 Code (unless --only / profile excluded t3)
  if (shouldConfigureT3) {
    if (!applyOnly) {
      setupT3({ autoInstall: true });
    } else {
      console.log(`\n${c.cyan}:: Step 1: T3 Code Config...${c.reset}`);
    }
    applyT3Config();
  }

  // 2. Select harnesses from menu (unless --only or applyOnly was passed)
  const needsSkillsOrHarness = !explicitSet || explicitSet.has("skills") || entries.some(([id]) => explicitSet.has(id));
  if (needsSkillsOrHarness) {
    console.log(`\n${c.cyan}:: Step 2: Harnesses & Shared Skills (${cfg.skillsRoot || "~/.agents/skills"})...${c.reset}`);
    const { canonicalRoot, canonicalSkills } = ensureCanonicalSkillsRoot(cfg);

    let selectedIds = null;
    if (!explicitSet && !applyOnly && rl) {
      selectedIds = await promptHarnessMenu(entries, rl);
    }

    for (const [id, h] of entries) {
      if (explicitSet) {
        if (!explicitSet.has(id) && !explicitSet.has("skills")) continue;
        if (explicitSet.has("skills") && !explicitSet.has(id)) {
          configureHarnessSkills(id, h, canonicalRoot, canonicalSkills);
          continue;
        }
      } else if (selectedIds && !selectedIds.has(id)) {
        console.log(`   :: Skipping ${h.name}.`);
        continue;
      }

      await setupHarness(id, h, { installCli: !applyOnly, rl, configureT3: shouldConfigureT3 });
    }
  }

  installGlobalBinWrappers();
  console.log(`\n${c.green}✨ Setup completed successfully!${c.reset}\n`);
}

// ========================================================
// 8. UNINSTALL
// ========================================================
export async function runUninstall(rl) {
  const ans = await ask(rl, ":: Are you sure you want to remove symlinks and Pi CLI? [y/N]: ", "N");
  if (!/^[Yy]/.test(ans)) {
    console.log(":: Uninstall cancelled.");
    return;
  }

  const cfg = loadHarnessesConfig();
  for (const h of Object.values(cfg.harnesses)) {
    if (h.skillsPath) {
      const sp = expandHome(h.skillsPath);
      try {
        if (fs.lstatSync(sp).isSymbolicLink()) fs.unlinkSync(sp);
      } catch {}
    }
  }

  runCmd("npm", ["uninstall", "-g", "@earendil-works/pi-coding-agent"]);
  console.log(`\n${c.green}✨ Uninstalled symlinks and Pi CLI. (Your ~/.agents repo was preserved).${c.reset}`);
}

async function promptActionMenu(actions, interactive) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Select an action (or run directly via CLI):");
    actions.forEach((a, idx) => {
      console.log(`  ${idx + 1}) ${a.label.padEnd(33)} ${a.hint}`);
    });
    console.log("");
    return ask(interactive, `Enter choice [1-${actions.length}] (default: 1): `, "1");
  }

  let cursor = 0;
  let renderedRows = 0;

  const render = () => {
    if (renderedRows > 0) {
      process.stdout.write(`\r\x1b[${renderedRows}A\r\x1b[0J`);
    }
    const lines = [
      `${c.bold}Select an action:${c.reset} ${c.cyan}(↑/↓ move, Enter select)${c.reset}`,
      ...actions.map((a, idx) => {
        const active = idx === cursor;
        const pointer = active ? `${c.cyan}❯${c.reset}` : " ";
        const label = active ? `${c.bold}${a.label.padEnd(34)}${c.reset}` : a.label.padEnd(34);
        const hint = a.hint ? ` ${c.yellow}${a.hint}${c.reset}` : "";
        return ` ${pointer} ${label}${hint}`;
      }),
    ];
    process.stdout.write(lines.join("\n") + "\n");
    renderedRows = countPhysicalRows(lines);
  };

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdout.write("\x1b[?25l");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render();

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + actions.length) % actions.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % actions.length;
        render();
      } else if (str && /^[1-9]$/.test(str) && Number(str) <= actions.length) {
        cursor = Number(str) - 1;
        render();
        cleanup();
        resolve(actions[cursor].id);
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(actions[cursor].id);
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

// ========================================================
// CLI ENTRYPOINT
// ========================================================
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "";

  let onlyModules = null;
  const onlyIdx = args.indexOf("--only");
  if (onlyIdx !== -1 && args[onlyIdx + 1]) {
    onlyModules = args[onlyIdx + 1].split(",");
  }

  if (cmd === "--doctor" || cmd === "-d" || cmd === "doctor") {
    runDoctor();
    return;
  }
  if (cmd === "--apply" || cmd === "apply") {
    await runInstall({ only: onlyModules, applyOnly: true });
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(`Usage: agents [COMMAND] [OPTIONS]

Commands:
  (none)                  Interactive modular manager menu
  setup, -i, --install    Choose T3 Code or Antigravity (agy) and configure skills
  apply, --apply          Configure skills and apply Pi, T3 Code & Agy configs without installing packages
  update, -u, --update    Update ~/.agents repo, Pi CLI, and Pi extensions
  sync, -s, --sync        Sync skills, Pi, T3 Code, and Agy settings to GitHub
  doctor, -d, --doctor    Check system health, T3 Code & Agy configs, and all harness skill configurations
  uninstall, --uninstall  Unlink compatibility symlinks and uninstall Pi CLI

Options:
  --only <h1,h2>          Non-interactive install for specific targets (e.g. --only agy or --only t3,pi,agy)`);
    return;
  }

  const interactive = true;
  if (cmd === "--update" || cmd === "-u" || cmd === "update") {
    await runUpdate(interactive);
    return;
  }
  if (cmd === "--sync" || cmd === "-s" || cmd === "sync") {
    await runSync(args.slice(1), interactive);
    return;
  }
  if (cmd === "--install" || cmd === "-i" || cmd === "install" || cmd === "setup" || cmd === "--setup") {
    await runInstall({ only: onlyModules, rl: interactive });
    return;
  }
  if (cmd === "--uninstall" || cmd === "uninstall") {
    await runUninstall(interactive);
    return;
  }

  console.log("==========================================================");
  console.log("  🚀 Universal AI Harness & Skills Manager (~/.agents)    ");
  console.log("==========================================================\n");

  const actions = [
    { id: "1", label: "Install (T3 Code / Antigravity)", hint: "(agents setup)" },
    { id: "2", label: "Apply Skills & Configs Only", hint: "(agents apply)" },
    { id: "3", label: "Update Repo, Pi CLI & Extensions", hint: "(agents update)" },
    { id: "4", label: "Sync Skills & Configs to GitHub", hint: "(agents sync)" },
    { id: "5", label: "Run System Health Check", hint: "(agents doctor)" },
    { id: "6", label: "Uninstall", hint: "(agents uninstall)" },
    { id: "7", label: "Exit", hint: "" },
  ];
  const choice = await promptActionMenu(actions, interactive);
  switch (choice) {
    case "1":
      await runInstall({ rl: interactive });
      break;
    case "2":
      await runInstall({ rl: interactive, applyOnly: true });
      break;
    case "3":
      await runUpdate(interactive);
      break;
    case "4":
      await runSync([], interactive);
      break;
    case "5":
      runDoctor();
      break;
    case "6":
      await runUninstall(interactive);
      break;
    case "7":
      console.log(":: Exiting.");
      break;
    default:
      console.error(":: Invalid choice.");
      process.exitCode = 1;
  }
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(fs.realpathSync(process.argv[1])) === path.resolve(fs.realpathSync(__filename));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
})();

if (isDirectRun) {
  main();
}
