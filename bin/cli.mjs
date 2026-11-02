#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    return execSync(checker, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function commandExists(cmd) {
  return getCommandPath(cmd) !== null;
}

function runCmd(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, {
    stdio: opts.silent ? "pipe" : "inherit",
    shell: IS_WIN,
    encoding: "utf8",
    ...opts,
  });
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

async function ask(rl, promptText, defaultVal = "") {
  if (!rl) return defaultVal;
  try {
    const ans = (await rl.question(promptText)).trim();
    return ans || defaultVal;
  } catch {
    return defaultVal;
  }
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

function enableT3Provider(t3Provider) {
  if (!t3Provider?.id) return;
  const userdata = expandHome("~/.t3/userdata");
  fs.mkdirSync(userdata, { recursive: true });
  const settingsDest = path.join(userdata, "settings.json");
  let existing = {};
  if (fs.existsSync(settingsDest)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsDest, "utf8"));
    } catch {}
  }
  existing.providerInstances = existing.providerInstances || {};
  existing.providerInstances[t3Provider.id] = {
    ...(existing.providerInstances[t3Provider.id] || {}),
    driver: t3Provider.driver || t3Provider.id,
    ...(t3Provider.displayName ? { displayName: t3Provider.displayName } : {}),
    enabled: true,
  };
  fs.writeFileSync(settingsDest, JSON.stringify(existing, null, 2) + "\n", "utf8");
  console.log(`   ${c.green}[✓]${c.reset} Enabled ${t3Provider.displayName || t3Provider.id} provider in T3 Code`);
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

export function linkAllSkills(selectedHarnesses = null) {
  const cfg = loadHarnessesConfig();
  const repoSkills = path.join(REPO_DIR, "skills");
  const canonicalRoot = cfg.skillsRoot || "~/.agents/skills";
  const canonicalSkills = expandHome(canonicalRoot);

  console.log(`\n${c.cyan}:: Configuring Universal Agent Skills (${canonicalRoot})...${c.reset}`);
  if (path.resolve(canonicalSkills) !== path.resolve(repoSkills)) {
    ensureSymlink(repoSkills, canonicalSkills);
    console.log(`   ${c.green}[✓]${c.reset} ${canonicalRoot} -> ${repoSkills}`);
  } else {
    console.log(`   ${c.green}[✓]${c.reset} Canonical directory ready: ${canonicalSkills}`);
  }

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
    const merged = {
      ...existing,
      ...template,
      packages: [...new Set([...(template.packages || []), ...(existing.packages || [])])],
    };
    fs.writeFileSync(settingsDest, JSON.stringify(merged, null, 2) + "\n", "utf8");
    console.log(`   ${c.green}[✓]${c.reset} Applied Pi settings.json template`);
  }

  if (installCli && commandExists("pi")) {
    console.log(":: Updating declared Pi extensions...");
    runCmd("pi", ["update", "--extensions"], { cwd: targetDir });
  }
}

export async function setupHarness(id, h, { installCli = true, rl = null } = {}) {
  const cfg = loadHarnessesConfig();
  const canonicalRoot = cfg.skillsRoot || "~/.agents/skills";
  const canonicalSkills = expandHome(canonicalRoot);

  console.log(`\n${c.cyan}:: Setting up ${h.name}...${c.reset}`);

  if (id === "pi") {
    await setupPi({ installCli, rl });
  } else if (installCli && h.bin && !commandExists(h.bin)) {
    if (!IS_WIN && h.aurPackage && commandExists("yay")) {
      console.log(`:: Installing ${h.name} via yay (${h.aurPackage})...`);
      runCmd("yay", ["-S", "--needed", "--noconfirm", h.aurPackage]);
    } else if (h.npmPackage && (await ensureNpm(rl))) {
      configureNpmUserPrefix();
      console.log(`:: Installing ${h.name} via npm (${h.npmPackage})...`);
      runCmd("npm", ["install", "-g", h.npmPackage]);
    }
  }

  configureHarnessSkills(id, h, canonicalRoot, canonicalSkills);
  if (h.t3Provider) {
    enableT3Provider(h.t3Provider);
  }
}

// ========================================================
// 3. GLOBAL CLI WRAPPER (~/.local/bin/agents)
// ========================================================
export function installGlobalBinWrappers() {
  if (IS_WIN) return;
  const localBin = path.join(HOME, ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  const cliPath = path.join(REPO_DIR, "bin", "cli.mjs");

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

  console.log("\n==========================================================\n");
}

// ========================================================
// 5. SYNC (Capture Pi Config & Push Skills to GitHub)
// ========================================================
export async function runSync(args = [], rl = null) {
  console.log("\n==========================================================");
  console.log("  🔄 Sync Skills & Pi Config to GitHub                    ");
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

  const statusOut = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_DIR, encoding: "utf8" }).stdout.trim();
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

  runCmd("git", ["add", "-A"], { cwd: REPO_DIR });
  runCmd("git", ["commit", "-m", customMsg], { cwd: REPO_DIR });

  if (!autoPush) {
    const ans = await ask(rl, "\n:: Push changes to GitHub now? [Y/n]: ", "Y");
    autoPush = /^[Yy]/.test(ans);
  }

  if (autoPush) {
    console.log(":: Pulling latest with rebase & pushing to origin...");
    runCmd("git", ["pull", "--rebase", "--autostash"], { cwd: REPO_DIR });
    runCmd("git", ["push"], { cwd: REPO_DIR });
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
  runCmd("git", ["pull", "--rebase", "--autostash"], { cwd: REPO_DIR });

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
function parseHarnessSelection(raw, entries) {
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

async function promptHarnessMenu(entries, rl) {
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
    const raw = await ask(rl, `Enter choices (e.g. 1,3 or pi,agy or a for all) [a]: `, "a");
    return parseHarnessSelection(raw, entries);
  }

  // Interactive arrow-key + spacebar checkbox menu
  rl.pause();
  const selected = new Set(entries.map(([id]) => id));
  let cursor = 0;
  let renderedLines = 0;

  const badges = entries.map(([, h]) => {
    const bins = Array.isArray(h.bin) ? h.bin : h.bin ? [h.bin] : [];
    const installed = bins.some(commandExists);
    return bins.length === 0 ? "" : installed ? ` ${c.green}(installed)${c.reset}` : ` ${c.yellow}(not installed)${c.reset}`;
  });

  const render = () => {
    if (renderedLines > 0) {
      process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
    }
    const lines = [
      `${c.bold}Select harnesses to install & configure:${c.reset} ${c.cyan}(↑/↓ move, Space toggle, a all, n none, Enter confirm)${c.reset}`,
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
    renderedLines = lines.length;
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
      process.stdout.write("\x1b[?25h");
      rl.resume();
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

export async function runInstall({ only = null, rl = null, applyOnly = false } = {}) {
  const cfg = loadHarnessesConfig();
  const entries = Object.entries(cfg.harnesses);
  const explicitSet = only ? new Set(only.map((m) => m.trim().toLowerCase())) : null;

  // 1. Auto-install T3 Code (unless --only was specified without t3, or applyOnly is set)
  if (!applyOnly && (!explicitSet || explicitSet.has("t3"))) {
    setupT3({ autoInstall: true });
  }

  // 2. Select harnesses from menu (unless --only or applyOnly was passed)
  console.log(`\n${c.cyan}:: Step 2: Harnesses & Shared Skills (${cfg.skillsRoot || "~/.agents/skills"})...${c.reset}`);
  let selectedIds = null;
  if (!explicitSet && !applyOnly && rl) {
    selectedIds = await promptHarnessMenu(entries, rl);
  }

  for (const [id, h] of entries) {
    if (explicitSet) {
      if (!explicitSet.has(id) && !explicitSet.has("skills")) continue;
      if (explicitSet.has("skills") && !explicitSet.has(id)) {
        configureHarnessSkills(id, h, cfg.skillsRoot || "~/.agents/skills", expandHome(cfg.skillsRoot || "~/.agents/skills"));
        continue;
      }
    } else if (selectedIds && !selectedIds.has(id)) {
      console.log(`   :: Skipping ${h.name}.`);
      continue;
    }

    await setupHarness(id, h, { installCli: !applyOnly, rl });
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

async function promptActionMenu(actions, rl) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Select an action (or run directly via CLI):");
    actions.forEach((a, idx) => {
      console.log(`  ${idx + 1}) ${a.label.padEnd(33)} ${a.hint}`);
    });
    console.log("");
    return ask(rl, `Enter choice [1-${actions.length}] (default: 1): `, "1");
  }

  rl.pause();
  let cursor = 0;
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) {
      process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
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
    renderedLines = lines.length;
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
      process.stdout.write("\x1b[?25h");
      rl.resume();
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
  setup, -i, --install    Auto-install T3 Code & choose harnesses from a single menu
  apply, --apply          Configure skills and apply Pi config without installing packages
  update, -u, --update    Update ~/.agents repo, Pi CLI, and Pi extensions
  sync, -s, --sync        Sync skills and Pi settings to GitHub
  doctor, -d, --doctor    Check system health and all harness skill configurations
  uninstall, --uninstall  Unlink compatibility symlinks and uninstall Pi CLI

Options:
  --only <h1,h2>          Non-interactive install for specific targets (e.g. --only t3,pi,agy)`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (cmd === "--update" || cmd === "-u" || cmd === "update") {
      await runUpdate(rl);
      return;
    }
    if (cmd === "--sync" || cmd === "-s" || cmd === "sync") {
      await runSync(args.slice(1), rl);
      return;
    }
    if (cmd === "--install" || cmd === "-i" || cmd === "install" || cmd === "setup" || cmd === "--setup") {
      await runInstall({ only: onlyModules, rl });
      return;
    }
    if (cmd === "--uninstall" || cmd === "uninstall") {
      await runUninstall(rl);
      return;
    }

    console.log("==========================================================");
    console.log("  🚀 Universal AI Harness & Skills Manager (~/.agents)    ");
    console.log("==========================================================\n");

    const actions = [
      { id: "1", label: "Install T3 Code & Harnesses", hint: "(agents setup)" },
      { id: "2", label: "Apply Skills & Configs Only", hint: "(agents apply)" },
      { id: "3", label: "Update Repo, Pi CLI & Extensions", hint: "(agents update)" },
      { id: "4", label: "Sync Skills & Pi Config to GitHub", hint: "(agents sync)" },
      { id: "5", label: "Run System Health Check", hint: "(agents doctor)" },
      { id: "6", label: "Uninstall", hint: "(agents uninstall)" },
      { id: "7", label: "Exit", hint: "" },
    ];
    const choice = await promptActionMenu(actions, rl);
    switch (choice) {
      case "1":
        await runInstall({ rl });
        break;
      case "2":
        await runInstall({ rl, applyOnly: true });
        break;
      case "3":
        await runUpdate(rl);
        break;
      case "4":
        await runSync([], rl);
        break;
      case "5":
        runDoctor();
        break;
      case "6":
        await runUninstall(rl);
        break;
      case "7":
        console.log(":: Exiting.");
        break;
      default:
        console.error(":: Invalid choice.");
        process.exitCode = 1;
    }
  } finally {
    rl.close();
  }
}

main();
