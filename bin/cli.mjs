#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// ========================================================
// 1. MODULE: SKILLS (~/.agents/skills standard)
// ========================================================
export function linkAllSkills() {
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

  for (const h of Object.values(cfg.harnesses)) {
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
}

// ========================================================
// 2. MODULE: PI CODING AGENT
// ========================================================
export async function setupPi({ installCli = true, rl = null } = {}) {
  const cfg = loadHarnessesConfig();
  const piCfg = cfg.harnesses.pi;
  const targetDir = expandHome(piCfg.targetDir || "~/.pi/agent");
  const srcDir = path.join(REPO_DIR, piCfg.configDir || "configs/pi");

  console.log(`\n${c.cyan}:: Setting up Pi Coding Agent...${c.reset}`);

  if (installCli && (await ensureNpm(rl))) {
    if (!IS_WIN) {
      const localBin = path.join(HOME, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      runCmd("npm", ["config", "set", "prefix", path.join(HOME, ".local")]);
      process.env.PATH = `${localBin}:${process.env.PATH}`;
    }
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

  // Symlink static files (zentui.json & extensions)
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

  // Merge settings.json template preserving volatile keys
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
    console.log(`   ${c.green}[✓]${c.reset} Applied settings.json template`);
  }

  if (installCli && commandExists("pi")) {
    console.log(":: Updating declared Pi extensions...");
    runCmd("pi", ["update", "--extensions"], { cwd: targetDir });
  }
}

// ========================================================
// 3. MODULE: T3 CODE (Optional Installer & Provider Enabler)
// ========================================================
export async function setupT3({ rl = null, askInstall = true } = {}) {
  const cfg = loadHarnessesConfig();
  const t3Cfg = cfg.harnesses.t3;
  const userdata = expandHome(t3Cfg.targetDir || "~/.t3/userdata");

  console.log(`\n${c.cyan}:: T3 Code Integration...${c.reset}`);

  const isT3Installed =
    commandExists("t3code") ||
    commandExists("t3") ||
    (IS_WIN &&
      (fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Programs", "t3code", "T3 Code.exe")) ||
        fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Programs", "t3code", "t3code.exe"))));

  if (!isT3Installed && askInstall) {
    const ans = await ask(rl, ":: T3 Code is not detected. Install T3 Code (Nightly) now? [Y/n]: ", "Y");
    if (/^[Yy]/.test(ans)) {
      if (IS_WIN) {
        console.log(":: Running T3 Code Windows installer...");
        runCmd("powershell", [
          "-NoProfile",
          "-Command",
          "$env:T3CODE_CHANNEL='nightly'; Invoke-Expression \"& { $(Invoke-RestMethod 'https://t3.codes/install.ps1') }\"",
        ]);
      } else if (commandExists("yay")) {
        console.log(":: Installing T3 Code Nightly via AUR (yay)...");
        runCmd("yay", ["-S", "--needed", "--noconfirm", "t3code-nightly-bin"]);
      } else if (commandExists("brew")) {
        console.log(":: Installing T3 Code via Homebrew...");
        runCmd("brew", ["install", "--cask", "t3-code"]);
      } else {
        console.log(":: Running official T3 Code Nightly installer...");
        runCmd("sh", ["-c", "curl -fsSL https://t3.codes/install.sh | T3CODE_CHANNEL=nightly sh"]);
      }
    }
  } else if (isT3Installed) {
    console.log(`   ${c.green}[✓]${c.reset} T3 Code binary detected`);
  }

  fs.mkdirSync(userdata, { recursive: true });
  const settingsDest = path.join(userdata, "settings.json");
  let existing = {};
  if (fs.existsSync(settingsDest)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsDest, "utf8"));
    } catch {}
  }
  existing.providerInstances = existing.providerInstances || {};
  existing.providerInstances.pi = {
    driver: "pi",
    displayName: "Pi",
    enabled: true,
    ...(existing.providerInstances.pi || {}),
  };
  fs.writeFileSync(settingsDest, JSON.stringify(existing, null, 2) + "\n", "utf8");
  console.log(`   ${c.green}[✓]${c.reset} Enabled Pi provider in ~/.t3/userdata/settings.json`);
}

// ========================================================
// 4. GLOBAL CLI WRAPPERS (~/.local/bin/pi-*)
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
// 5. HEALTH CHECK (DOCTOR)
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
    } else if (h.skillsMode === "delegated") {
      skillStatus = `${c.green}delegates to active provider${c.reset}`;
    } else if (h.skillsMode === "config" && h.configFile) {
      const cfgPath = expandHome(h.configFile);
      let ok = false;
      if (fs.existsSync(cfgPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          ok = Array.isArray(parsed.skills) && parsed.skills.includes(canonicalRoot);
        } catch {}
      }
      skillStatus = ok
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
// 6. CAPTURE / SYNC (Skills + Pi Settings -> GitHub)
// ========================================================
export async function runSync(args = [], rl = null) {
  let autoPush = false;
  let customMsg = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--push" || args[i] === "-p") {
      autoPush = true;
    } else if (args[i] === "-m" || args[i] === "--message") {
      customMsg = args[++i] || "";
    } else if (!customMsg) {
      customMsg = args[i];
    }
  }

  console.log("\n==========================================================");
  console.log("  🔄 Sync Skills & Pi Settings to ~/.agents Repository    ");
  console.log("==========================================================\n");

  const cfg = loadHarnessesConfig();
  const piTarget = expandHome(cfg.harnesses.pi?.targetDir || "~/.pi/agent");
  const piSrc = path.join(REPO_DIR, cfg.harnesses.pi?.configDir || "configs/pi");
  const liveSettings = path.join(piTarget, "settings.json");

  if (fs.existsSync(liveSettings)) {
    try {
      const data = JSON.parse(fs.readFileSync(liveSettings, "utf8"));
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
// 7. UPDATE
// ========================================================
export function runUpdate() {
  console.log("\n==========================================================");
  console.log("  ⬆️  Updating ~/.agents, Pi CLI & Extensions             ");
  console.log("==========================================================\n");

  console.log(":: 1/3 Pulling latest ~/.agents repository...");
  runCmd("git", ["pull", "--rebase", "--autostash"], { cwd: REPO_DIR });

  console.log("\n:: 2/3 Updating @earendil-works/pi-coding-agent...");
  runCmd("npm", ["install", "-g", "@earendil-works/pi-coding-agent"]);

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
// 8. MODULAR INSTALL / APPLY
// ========================================================
export async function runInstall({ modules = ["skills", "pi", "t3"], rl = null, applyOnly = false } = {}) {
  const set = new Set(modules.map((m) => m.trim().toLowerCase()));

  if (set.has("skills")) {
    linkAllSkills();
  }
  if (set.has("pi")) {
    await setupPi({ installCli: !applyOnly, rl });
  }
  if (set.has("t3")) {
    await setupT3({ rl, askInstall: !applyOnly });
  }
  installGlobalBinWrappers();
  console.log(`\n${c.green}✨ Setup completed successfully!${c.reset}\n`);
}

// ========================================================
// 9. UNINSTALL
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

// ========================================================
// CLI ENTRYPOINT
// ========================================================
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "";

  let onlyModules = ["skills", "pi", "t3"];
  const onlyIdx = args.indexOf("--only");
  if (onlyIdx !== -1 && args[onlyIdx + 1]) {
    onlyModules = args[onlyIdx + 1].split(",");
  }

  if (cmd === "--doctor" || cmd === "-d" || cmd === "doctor") {
    runDoctor();
    return;
  }
  if (cmd === "--update" || cmd === "-u" || cmd === "update") {
    runUpdate();
    return;
  }
  if (cmd === "--apply" || cmd === "apply") {
    await runInstall({ modules: onlyModules, applyOnly: true });
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(`Usage: agents [COMMAND] [OPTIONS]

Commands:
  (none)                  Interactive modular manager menu
  setup, -i, --install    Install & configure modules (default: skills,pi,t3)
  apply, --apply          Configure skills and apply Pi config without installing packages
  update, -u, --update    Update ~/.agents repo, Pi CLI, and Pi extensions
  sync, -s, --sync        Sync skills and Pi settings to GitHub
  doctor, -d, --doctor    Check system health and all harness skill configurations
  uninstall, --uninstall  Unlink compatibility symlinks and uninstall Pi CLI

Options:
  --only <m1,m2>          Select specific modules: skills, pi, t3 (e.g. --only skills,t3)`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (cmd === "--sync" || cmd === "-s" || cmd === "sync") {
      await runSync(args.slice(1), rl);
      return;
    }
    if (cmd === "--install" || cmd === "-i" || cmd === "install" || cmd === "setup" || cmd === "--setup") {
      await runInstall({ modules: onlyModules, rl });
      return;
    }
    if (cmd === "--uninstall" || cmd === "uninstall") {
      await runUninstall(rl);
      return;
    }

    console.log("==========================================================");
    console.log("  🚀 Universal AI Harness & Skills Manager (~/.agents)    ");
    console.log("==========================================================\n");
    console.log("Select an action:");
    console.log("  1) Install / Configure All (Skills + Pi + Optional T3 Code)");
    console.log("  2) Configure Universal Skills Only (~/.agents/skills)");
    console.log("  3) Update Pi & Extensions (agents update)");
    console.log("  4) Sync Skills & Pi Config to GitHub (agents sync)");
    console.log("  5) Run System Health Check (agents doctor)");
    console.log("  6) Uninstall");
    console.log("  7) Exit\n");

    const choice = await ask(rl, "Enter choice [1-7] (default: 1): ", "1");
    switch (choice) {
      case "1":
        await runInstall({ modules: ["skills", "pi", "t3"], rl });
        break;
      case "2":
        await runInstall({ modules: ["skills"], rl, applyOnly: true });
        break;
      case "3":
        runUpdate();
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
