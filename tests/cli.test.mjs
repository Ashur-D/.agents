import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyAgyConfig,
  applyT3Config,
  captureAgyConfig,
  captureT3Config,
  configureHarnessSkills,
  enableT3Provider,
  ensureCanonicalSkillsRoot,
  mergeAgyConfig,
  mergePiSettings,
  mergeT3ClientSettings,
  mergeT3Settings,
  parseHarnessSelection,
  readT3DesktopAppearance,
  resolveDesktopActiveTheme,
  resolveInstallProfile,
  sanitizeAgyConfig,
  sanitizeT3ClientSettings,
  sanitizeT3Settings,
  toEnvironmentThemeFile,
} from "../bin/cli.mjs";
import { readElectronLocalStorage } from "../bin/leveldb-reader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "..");

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("repository configs", () => {
  it("harnesses.json is valid and declares t3 and harnesses", () => {
    const raw = fs.readFileSync(path.join(REPO_DIR, "harnesses.json"), "utf8");
    const cfg = JSON.parse(raw);
    assert.equal(typeof cfg.skillsRoot, "string");
    assert.deepEqual(cfg.t3, { configDir: "configs/t3", targetDir: "~/.t3/userdata" });
    assert.ok(cfg.harnesses && typeof cfg.harnesses === "object");
    assert.ok(cfg.harnesses.pi);
    assert.ok(cfg.harnesses.opencode);
    assert.ok(cfg.harnesses.agy);
  });

  it("configs/pi/settings.json is valid and excludes removed pi-antigravity", () => {
    const raw = fs.readFileSync(path.join(REPO_DIR, "configs", "pi", "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    assert.ok(Array.isArray(settings.packages));
    assert.ok(!settings.packages.includes("npm:pi-antigravity"));
  });

  it("configs/t3 files are valid JSON and exclude machine-local or secret fields", () => {
    const t3Dir = path.join(REPO_DIR, "configs", "t3");
    const settings = JSON.parse(fs.readFileSync(path.join(t3Dir, "settings.json"), "utf8"));
    for (const key of ["environmentIcon", "defaultThemeSetAt", "defaultAppearanceSetAt"]) {
      assert.equal(key in settings, false, `unexpected local key in settings.json: ${key}`);
    }
    for (const [id, inst] of Object.entries(settings.providerInstances || {})) {
      const cfg = inst.config || {};
      for (const secretKey of ["apiKey", "token", "binaryPath", "gcpProject", "gcpLocation", "homePath", "executablePath", "launchArgs", "env"]) {
        assert.equal(secretKey in cfg, false, `unexpected key ${secretKey} in providerInstances.${id}.config`);
      }
    }

    const clientSettings = JSON.parse(fs.readFileSync(path.join(t3Dir, "client-settings.json"), "utf8"));
    for (const key of [
      "voiceMicrophone",
      "voiceMicrophones",
      "onboardingCompletedAt",
      "browserProfiles",
      "browserDefaultProfileId",
      "sidebarProjectGroupingOverrides",
      "pullRequestMergeMethodOverrides",
    ]) {
      assert.equal(key in clientSettings, false, `unexpected local key in client-settings.json: ${key}`);
    }

    const keybindings = JSON.parse(fs.readFileSync(path.join(t3Dir, "keybindings.json"), "utf8"));
    assert.ok(Array.isArray(keybindings));

    assert.equal(settings.defaultTheme, "midnight-lo-fi-studio-reference-edition");
    assert.equal(settings.defaultAppearance, "dark");

    const themesDir = path.join(t3Dir, "themes");
    const activeThemePath = path.join(themesDir, "midnight-lo-fi-studio-reference-edition.json");
    assert.equal(fs.existsSync(activeThemePath), true);
    const activeTheme = JSON.parse(fs.readFileSync(activeThemePath, "utf8"));
    assert.equal(activeTheme.version, 1);
    assert.equal(typeof activeTheme.name, "string");
    assert.equal(activeTheme.appearance, "dark");
    assert.ok(activeTheme.colors && typeof activeTheme.colors === "object");
    assert.match(activeTheme.css, /background-image/);
    assert.equal(fs.existsSync(path.join(themesDir, "ocean-wallpaper.json")), false);
    assert.equal(fs.existsSync(path.join(themesDir, "zeron.json")), false);
  });
});

describe("parseHarnessSelection", () => {
  const entries = [
    ["pi", { name: "Pi Coding Agent" }],
    ["opencode", { name: "OpenCode" }],
    ["agy", { name: "Antigravity (Gemini)" }],
  ];

  it("selects all for empty, a, all, *", () => {
    assert.deepEqual([...parseHarnessSelection("", entries)], ["pi", "opencode", "agy"]);
    assert.deepEqual([...parseHarnessSelection("a", entries)], ["pi", "opencode", "agy"]);
    assert.deepEqual([...parseHarnessSelection("ALL", entries)], ["pi", "opencode", "agy"]);
    assert.deepEqual([...parseHarnessSelection("*", entries)], ["pi", "opencode", "agy"]);
  });

  it("selects none for n, none, 0", () => {
    assert.deepEqual([...parseHarnessSelection("n", entries)], []);
    assert.deepEqual([...parseHarnessSelection("none", entries)], []);
    assert.deepEqual([...parseHarnessSelection("0", entries)], []);
  });

  it("supports numeric indices and ids", () => {
    assert.deepEqual([...parseHarnessSelection("1,3", entries)], ["pi", "agy"]);
    assert.deepEqual([...parseHarnessSelection("opencode pi", entries)], ["opencode", "pi"]);
  });
});

describe("mergePiSettings", () => {
  it("preserves local machine fields while letting template packages remove deleted entries", () => {
    const existing = {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      defaultThinkingLevel: "medium",
      packages: ["npm:pi-web-access", "npm:pi-antigravity", "npm:pi-lens"],
    };
    const template = {
      theme: "system",
      packages: ["npm:pi-web-access", "npm:pi-lens", "npm:pi-lens"],
    };

    const merged = mergePiSettings(existing, template);
    assert.equal(merged.defaultProvider, "anthropic");
    assert.equal(merged.defaultModel, "claude-sonnet-4-5");
    assert.equal(merged.defaultThinkingLevel, "medium");
    assert.equal(merged.theme, "system");
    assert.deepEqual(merged.packages, ["npm:pi-web-access", "npm:pi-lens"]);
  });
});

describe("skills linking & harness configuration", () => {
  it("ensureCanonicalSkillsRoot symlinks external canonical path to repo/skills", () => {
    const tmp = makeTempDir();
    const fakeRepo = path.join(tmp, "repo");
    const repoSkills = path.join(fakeRepo, "skills");
    fs.mkdirSync(repoSkills, { recursive: true });

    const canonical = path.join(tmp, "canonical-skills");
    const result = ensureCanonicalSkillsRoot({ skillsRoot: canonical }, fakeRepo);

    assert.equal(result.canonicalSkills, canonical);
    assert.ok(fs.lstatSync(canonical).isSymbolicLink());
    assert.equal(fs.realpathSync(canonical), fs.realpathSync(repoSkills));
  });

  it("configureHarnessSkills handles config mode idempotently", () => {
    const tmp = makeTempDir();
    const cfgFile = path.join(tmp, "opencode.json");
    fs.writeFileSync(cfgFile, JSON.stringify({ model: "test", skills: ["~/custom"] }), "utf8");

    const h = { name: "OpenCode", skillsMode: "config", configFile: cfgFile };
    configureHarnessSkills("opencode", h, "~/.agents/skills", path.join(REPO_DIR, "skills"));
    configureHarnessSkills("opencode", h, "~/.agents/skills", path.join(REPO_DIR, "skills"));

    const written = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    assert.equal(written.model, "test");
    assert.deepEqual(written.skills, ["~/custom", "~/.agents/skills"]);
  });

  it("configureHarnessSkills handles symlink mode", () => {
    const tmp = makeTempDir();
    const targetSkills = path.join(tmp, "skills-src");
    const linkSkills = path.join(tmp, "agy-skills");
    fs.mkdirSync(targetSkills, { recursive: true });

    const h = { name: "Antigravity", skillsMode: "symlink", skillsPath: linkSkills };
    configureHarnessSkills("agy", h, "~/.agents/skills", targetSkills);

    assert.ok(fs.lstatSync(linkSkills).isSymbolicLink());
    assert.equal(fs.realpathSync(linkSkills), fs.realpathSync(targetSkills));
  });
});

describe("CLI smoke test", () => {
  it("prints help and exits 0", () => {
    const res = spawnSync(process.execPath, [path.join(REPO_DIR, "bin", "cli.mjs"), "--help"], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage: agents/);
  });
});

describe("T3 Code settings sanitization and merging", () => {
  it("sanitizeT3Settings strips local fields and provider secrets/paths while keeping allowlisted fields", () => {
    const raw = {
      defaultTheme: "zeron",
      defaultThemeSetAt: "2026-11-16T01:30:12.069Z",
      defaultAppearance: "dark",
      defaultAppearanceSetAt: "2026-11-16T01:30:12.069Z",
      environmentIcon: "linux",
      customApiToken: "secret-123",
      favorites: [{ provider: "antigravity", model: "gemini-4-neon" }],
      providerInstances: {
        antigravity: {
          driver: "antigravity",
          enabled: true,
          config: {
            apiKey: "super-secret",
            token: "tok",
            gcpProject: "my-proj",
            gcpLocation: "us-central1",
            binaryPath: "/usr/bin/agy",
            homePath: "/home/ash",
            executablePath: "/opt/agy",
            launchArgs: "--foo",
            env: { FOO: "bar" },
            customModels: ["my-custom-model"],
          },
        },
        pi: {
          driver: "pi",
          displayName: "Pi",
          enabled: false,
          config: { customModels: [] },
        },
      },
    };

    const sanitized = sanitizeT3Settings(raw);
    assert.equal(sanitized.defaultTheme, "zeron");
    assert.equal("defaultThemeSetAt" in sanitized, false);
    assert.equal("defaultAppearanceSetAt" in sanitized, false);
    assert.equal("environmentIcon" in sanitized, false);
    assert.equal("customApiToken" in sanitized, false);
    assert.deepEqual(sanitized.providerInstances.antigravity, {
      driver: "antigravity",
      enabled: true,
      config: { customModels: ["my-custom-model"] },
    });
    assert.deepEqual(sanitized.providerInstances.pi, {
      driver: "pi",
      displayName: "Pi",
      enabled: false,
    });
  });

  it("mergeT3Settings preserves local icon, providers, and secrets while syncing removals and clearing stale timestamps", () => {
    const existing = {
      environmentIcon: "windows",
      defaultTheme: "ocean",
      defaultThemeSetAt: "2026-10-01T00:00:00.000Z",
      defaultAppearance: "dark",
      defaultAppearanceSetAt: "2026-10-01T00:00:00.000Z",
      favorites: [
        { provider: "pi", model: "old-model" },
        { provider: "antigravity", model: "gemini-4-neon" },
      ],
      providerModelPreferences: {
        pi: { hiddenModels: ["old-hidden"], modelOrder: ["m1", "m2"] },
        localOnly: { hiddenModels: ["local-m"], modelOrder: [] },
      },
      providerInstances: {
        antigravity: {
          driver: "antigravity",
          enabled: false,
          config: { apiKey: "local-secret", binaryPath: "C:\\agy.exe", customModels: ["old"] },
        },
        localCustom: {
          driver: "custom",
          enabled: true,
          config: { binaryPath: "/local/bin/custom" },
        },
      },
    };
    const template = {
      defaultTheme: "zeron",
      defaultAppearance: "dark",
      favorites: [{ provider: "antigravity", model: "gemini-4-neon" }],
      providerModelPreferences: {
        pi: { hiddenModels: [], modelOrder: ["m2"] },
      },
      providerInstances: {
        antigravity: {
          driver: "antigravity",
          enabled: true,
          config: { customModels: ["synced-model"] },
        },
      },
    };

    const merged = mergeT3Settings(existing, template);
    assert.equal(merged.environmentIcon, "windows");
    assert.equal(merged.defaultTheme, "zeron");
    assert.equal("defaultThemeSetAt" in merged, false);
    assert.equal(merged.defaultAppearanceSetAt, "2026-10-01T00:00:00.000Z");
    assert.deepEqual(merged.favorites, [{ provider: "antigravity", model: "gemini-4-neon" }]);
    assert.deepEqual(merged.providerModelPreferences, {
      pi: { hiddenModels: [], modelOrder: ["m2"] },
      localOnly: { hiddenModels: ["local-m"], modelOrder: [] },
    });
    assert.deepEqual(merged.providerInstances.antigravity, {
      driver: "antigravity",
      enabled: true,
      config: { apiKey: "local-secret", binaryPath: "C:\\agy.exe", customModels: ["synced-model"] },
    });
    assert.deepEqual(merged.providerInstances.localCustom, existing.providerInstances.localCustom);
  });

  it("sanitizeT3ClientSettings and mergeT3ClientSettings strip/preserve local hardware and profile fields", () => {
    const raw = {
      fontFamilySans: "Maple Mono",
      voiceMicrophone: "mic-1",
      voiceMicrophones: [{ kind: "device", deviceId: "abc" }],
      onboardingCompletedAt: "2026-11-10T00:00:00Z",
      browserProfiles: [{ id: "p1" }],
      browserDefaultProfileId: "p1",
      sidebarProjectGroupingOverrides: { proj1: "folder" },
      pullRequestMergeMethodOverrides: { repo1: "squash" },
      apiToken: "secret",
    };

    const sanitized = sanitizeT3ClientSettings(raw);
    assert.deepEqual(sanitized, { fontFamilySans: "Maple Mono" });

    const existing = {
      fontFamilySans: "Inter",
      voiceMicrophone: "local-mic",
      browserProfiles: [{ id: "local-profile" }],
    };
    assert.deepEqual(mergeT3ClientSettings(existing, sanitized), {
      fontFamilySans: "Maple Mono",
      voiceMicrophone: "local-mic",
      browserProfiles: [{ id: "local-profile" }],
    });
  });

  it("captureT3Config and applyT3Config round-trip configs and binary themes while protecting local state", () => {
    const tmp = makeTempDir();
    const machineA = path.join(tmp, "machineA");
    const repoCfg = path.join(tmp, "repo-t3");
    const machineB = path.join(tmp, "machineB");

    fs.mkdirSync(path.join(machineA, "themes"), { recursive: true });
    fs.writeFileSync(
      path.join(machineA, "settings.json"),
      JSON.stringify({
        environmentIcon: "linux",
        defaultTheme: "zeron",
        providerInstances: {
          antigravity: { driver: "antigravity", enabled: true, config: { apiKey: "secret-a", customModels: ["m1"] } },
        },
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(machineA, "client-settings.json"),
      JSON.stringify({ fontSizeInterface: 16, voiceMicrophone: "mic-a", browserProfiles: [{ id: "a" }] }),
      "utf8"
    );
    fs.writeFileSync(path.join(machineA, "keybindings.json"), JSON.stringify([{ key: "mod+k", command: "commandPalette.toggle" }]), "utf8");
    fs.writeFileSync(path.join(machineA, "themes", "zeron.json"), '{"name":"Zeron"}\n', "utf8");
    fs.writeFileSync(path.join(machineA, "themes", "other-theme.json"), '{"name":"Other"}\n', "utf8");
    const webpBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x57, 0x45, 0x42, 0x50]);
    fs.writeFileSync(path.join(machineA, "themes", "zeron.webp"), webpBytes);
    fs.writeFileSync(path.join(machineA, "themes", "noctalia.json"), '{"name":"Noctalia"}\n', "utf8");
    fs.writeFileSync(path.join(machineA, "themes", ".hidden.json"), "{}\n", "utf8");

    const cap1 = captureT3Config({ srcDir: repoCfg, targetDir: machineA, desktopStorageDir: null });
    assert.deepEqual(cap1.captured, ["settings.json", "client-settings.json", "keybindings.json"]);
    assert.deepEqual(cap1.themes.sort(), ["zeron.json", "zeron.webp"]);
    assert.equal(fs.existsSync(path.join(repoCfg, "themes", "other-theme.json")), false);
    assert.equal(fs.existsSync(path.join(repoCfg, "themes", "noctalia.json")), false);
    assert.equal(fs.existsSync(path.join(repoCfg, "themes", ".hidden.json")), false);
    assert.ok(Buffer.compare(fs.readFileSync(path.join(repoCfg, "themes", "zeron.webp")), webpBytes) === 0);

    // Deleting a companion background image locally prunes it from repo on re-capture
    fs.unlinkSync(path.join(machineA, "themes", "zeron.webp"));
    const cap2 = captureT3Config({ srcDir: repoCfg, targetDir: machineA, desktopStorageDir: null });
    assert.deepEqual(cap2.themes, ["zeron.json"]);
    assert.equal(fs.existsSync(path.join(repoCfg, "themes", "zeron.webp")), false);

    // Apply onto empty machineB
    const emptyB = path.join(machineB, "empty");
    const appEmpty = applyT3Config({ srcDir: repoCfg, targetDir: emptyB });
    assert.deepEqual(appEmpty.applied, ["settings.json", "client-settings.json", "keybindings.json"]);
    assert.deepEqual(appEmpty.themes, ["zeron.json"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(emptyB, "settings.json"), "utf8")).defaultTheme, "zeron");

    // Apply onto pre-existing machineB preserving local secrets, devices, and local themes; skipping corrupt file
    const populatedB = path.join(machineB, "populated");
    fs.mkdirSync(path.join(populatedB, "themes"), { recursive: true });
    fs.writeFileSync(
      path.join(populatedB, "settings.json"),
      JSON.stringify({
        environmentIcon: "darwin",
        providerInstances: {
          antigravity: { driver: "antigravity", enabled: false, config: { apiKey: "secret-b", binaryPath: "/mac/agy" } },
        },
      }),
      "utf8"
    );
    fs.writeFileSync(path.join(populatedB, "client-settings.json"), "{corrupt-json", "utf8");
    fs.writeFileSync(path.join(populatedB, "themes", "local-only.json"), '{"name":"Local"}\n', "utf8");

    const appPop = applyT3Config({ srcDir: repoCfg, targetDir: populatedB });
    assert.deepEqual(appPop.applied, ["settings.json", "keybindings.json"]);
    assert.equal(fs.readFileSync(path.join(populatedB, "client-settings.json"), "utf8"), "{corrupt-json");
    assert.equal(fs.existsSync(path.join(populatedB, "themes", "local-only.json")), true);
    assert.equal(fs.existsSync(path.join(populatedB, "themes", "zeron.json")), true);
    const mergedB = JSON.parse(fs.readFileSync(path.join(populatedB, "settings.json"), "utf8"));
    assert.equal(mergedB.environmentIcon, "darwin");
    assert.equal(mergedB.providerInstances.antigravity.config.apiKey, "secret-b");
    assert.deepEqual(mergedB.providerInstances.antigravity.config.customModels, ["m1"]);
  });

  it("enableT3Provider honors preserveExistingEnabled", () => {
    const tmp = makeTempDir();
    const settingsPath = path.join(tmp, "settings.json");

    enableT3Provider({ id: "opencode", driver: "opencode", displayName: "OpenCode" }, { targetDir: tmp, preserveExistingEnabled: true });
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).providerInstances.opencode.enabled, true);

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ providerInstances: { pi: { driver: "pi", displayName: "Pi", enabled: false } } }),
      "utf8"
    );
    enableT3Provider({ id: "pi", driver: "pi", displayName: "Pi" }, { targetDir: tmp, preserveExistingEnabled: true });
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).providerInstances.pi.enabled, false);

    enableT3Provider({ id: "pi", driver: "pi", displayName: "Pi" }, { targetDir: tmp, preserveExistingEnabled: false });
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).providerInstances.pi.enabled, true);
  });
});

function encodeVarint(n) {
  const bytes = [];
  let v = n;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function writeSyntheticLevelDbLog(dir, batches) {
  fs.mkdirSync(dir, { recursive: true });
  const chunks = [];
  for (const { seq, ops } of batches) {
    const body = [Buffer.alloc(12)];
    body[0].writeBigUInt64LE(BigInt(seq), 0);
    body[0].writeUInt32LE(ops.length, 8);
    for (const op of ops) {
      const keyBuf = Buffer.from(op.key, "latin1");
      if (op.type === "put") {
        const valBuf = op.encoding === "utf16le"
          ? Buffer.concat([Buffer.from([0]), Buffer.from(op.val, "utf16le")])
          : Buffer.concat([Buffer.from([1]), Buffer.from(op.val, "latin1")]);
        body.push(Buffer.from([1]), encodeVarint(keyBuf.length), keyBuf, encodeVarint(valBuf.length), valBuf);
      } else {
        body.push(Buffer.from([0]), encodeVarint(keyBuf.length), keyBuf);
      }
    }
    const batchBuf = Buffer.concat(body);
    const header = Buffer.alloc(7);
    header.writeUInt32LE(0, 0);
    header.writeUInt16LE(batchBuf.length, 4);
    header[6] = 1; // FULL WAL record
    chunks.push(header, batchBuf);
  }
  fs.writeFileSync(path.join(dir, "000001.log"), Buffer.concat(chunks));
}

describe("T3 Desktop LevelDB appearance detection", () => {
  it("resolveDesktopActiveTheme resolves theme halves, fallback theme, and stock themes", () => {
    assert.deepEqual(
      resolveDesktopActiveTheme({
        theme: "koi-pond",
        appearanceMode: "dark",
        themeHalves: { dark: "midnight-custom", light: "rainy-window" },
      }),
      { themeId: "midnight-custom", defaultTheme: "midnight-custom", appearanceMode: "dark" }
    );
    assert.deepEqual(
      resolveDesktopActiveTheme({
        theme: "koi-pond",
        appearanceMode: "light",
        themeHalves: { dark: "midnight-custom" },
      }),
      { themeId: "koi-pond", defaultTheme: "koi-pond", appearanceMode: "light" }
    );
    assert.deepEqual(
      resolveDesktopActiveTheme({ theme: "t3-code", appearanceMode: "dark" }),
      { themeId: "t3-code", defaultTheme: "", appearanceMode: "dark" }
    );
    assert.deepEqual(
      resolveDesktopActiveTheme({ theme: "dark" }),
      { themeId: "dark", defaultTheme: "", appearanceMode: "dark" }
    );
  });

  it("toEnvironmentThemeFile maps label to name, strips id, and validates schema rules", () => {
    const exported = toEnvironmentThemeFile({
      id: "midnight-custom",
      label: "Midnight Custom",
      appearance: "dark",
      colors: { canvas: "oklch(0.15 0.03 280)" },
      variants: { light: { canvas: "#ffffff" }, empty: {} },
      css: ".dark { color-scheme: dark; }",
    });
    assert.deepEqual(exported, {
      version: 1,
      name: "Midnight Custom",
      appearance: "dark",
      colors: { canvas: "oklch(0.15 0.03 280)" },
      variants: { light: { canvas: "#ffffff" } },
      css: ".dark { color-scheme: dark; }",
    });
    assert.equal("id" in exported, false);
    assert.equal("label" in exported, false);
    assert.equal(toEnvironmentThemeFile({ label: "Broken", appearance: "dark" }), null);
    assert.equal(toEnvironmentThemeFile({ label: "Bad Mode", appearance: "auto", colors: { canvas: "#000" } }), null);
    assert.equal(toEnvironmentThemeFile({ label: "x".repeat(49), appearance: "dark", colors: { canvas: "#000" } }), null);
  });

  it("readElectronLocalStorage and readT3DesktopAppearance decode LevelDB WAL records including PUT/DEL ordering", () => {
    const tmp = makeTempDir();
    const ldbDir = path.join(tmp, "leveldb");
    const customThemes = [
      {
        id: "midnight-custom",
        label: "Midnight Custom",
        appearance: "dark",
        colors: { canvas: "#09091b", accent: "#ffbe6a" },
        css: '[data-workspace-area="conversation"] { background-image: url("data:image/svg+xml,<svg/>"); }',
      },
      {
        id: "unused-theme",
        label: "Unused Theme",
        appearance: "dark",
        colors: { canvas: "#111", accent: "#222" },
      },
    ];

    writeSyntheticLevelDbLog(ldbDir, [
      {
        seq: 1,
        ops: [
          { type: "put", key: "_t3code://app\x00\x01t3code:theme", val: "ocean" },
          { type: "put", key: "_t3code://app\x00\x01t3code:theme-appearance-mode", val: "light" },
          { type: "put", key: "_t3code://app\x00\x01t3code:stale-key", val: "drop-me" },
        ],
      },
      {
        seq: 10,
        ops: [
          { type: "del", key: "_t3code://app\x00\x01t3code:stale-key" },
          { type: "put", key: "_t3code://app\x00\x01t3code:theme", val: "koi-pond" },
          { type: "put", key: "_t3code://app\x00\x01t3code:theme-appearance-mode", val: "dark" },
          { type: "put", key: "_t3code://app\x00\x01t3code:theme-halves:v1", val: '{"dark":"midnight-custom"}', encoding: "utf16le" },
          { type: "put", key: "_t3code://app\x00\x01t3code:themes:v1", val: JSON.stringify(customThemes) },
        ],
      },
    ]);

    const ls = readElectronLocalStorage(ldbDir);
    assert.equal(ls.get("t3code:stale-key"), undefined);
    assert.equal(ls.get("t3code:theme"), "koi-pond");
    assert.equal(ls.get("t3code:theme-halves:v1"), '{"dark":"midnight-custom"}');

    const detected = readT3DesktopAppearance({ desktopStorageDir: ldbDir });
    assert.equal(detected.defaultTheme, "midnight-custom");
    assert.equal(detected.appearanceMode, "dark");
    assert.equal(detected.themeFile.version, 1);
    assert.equal(detected.themeFile.name, "Midnight Custom");
    assert.match(detected.themeFile.css, /background-image/);

    // Also test captureT3Config overriding stale settings.json and pruning unused themes
    const userdataDir = path.join(tmp, "userdata");
    const repoCfgDir = path.join(tmp, "repo-t3");
    fs.mkdirSync(userdataDir, { recursive: true });
    fs.mkdirSync(path.join(repoCfgDir, "themes"), { recursive: true });
    fs.writeFileSync(
      path.join(userdataDir, "settings.json"),
      JSON.stringify({ defaultTheme: "ocean-wallpaper", defaultAppearance: "light" }),
      "utf8"
    );
    fs.writeFileSync(path.join(repoCfgDir, "themes", "ocean-wallpaper.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(repoCfgDir, "themes", "zeron.json"), "{}\n", "utf8");

    const res = captureT3Config({ srcDir: repoCfgDir, targetDir: userdataDir, desktopStorageDir: ldbDir });
    assert.deepEqual(res.themes, ["midnight-custom.json"]);
    const syncedSettings = JSON.parse(fs.readFileSync(path.join(repoCfgDir, "settings.json"), "utf8"));
    assert.equal(syncedSettings.defaultTheme, "midnight-custom");
    assert.equal(syncedSettings.defaultAppearance, "dark");
    assert.equal(fs.existsSync(path.join(repoCfgDir, "themes", "midnight-custom.json")), true);
    assert.equal(fs.existsSync(path.join(repoCfgDir, "themes", "ocean-wallpaper.json")), false);
    assert.equal(fs.existsSync(path.join(repoCfgDir, "themes", "zeron.json")), false);
  });
});

describe("resolveInstallProfile", () => {
  it("maps interactive profile choices to target modules", () => {
    assert.equal(resolveInstallProfile("1"), null);
    assert.deepEqual(resolveInstallProfile("2"), ["agy"]);
    assert.deepEqual(resolveInstallProfile("agy"), ["agy"]);
    assert.deepEqual(resolveInstallProfile("3"), ["t3", "skills"]);
    assert.deepEqual(resolveInstallProfile("t3code"), ["t3", "skills"]);
  });
});

describe("Antigravity config sanitization and merging", () => {
  it("configs/agy/config.json is valid and excludes sidecars and remoteControlHostname", () => {
    const raw = fs.readFileSync(path.join(REPO_DIR, "configs", "agy", "config.json"), "utf8");
    const cfg = JSON.parse(raw);
    assert.equal("sidecars" in cfg, false);
    assert.ok(cfg.userSettings && typeof cfg.userSettings === "object");
    assert.equal("remoteControlHostname" in cfg.userSettings, false);
  });

  it("sanitizeAgyConfig strips sidecars, remoteControlHostname, and secrets while keeping userSettings", () => {
    const sanitized = sanitizeAgyConfig({
      sidecars: { "swarm/swarm_board": { projectId: "abc-123" } },
      userSettings: {
        artifactReviewMode: "ARTIFACT_REVIEW_MODE_ALWAYS",
        remoteControlHostname: "my-pc",
        apiToken: "secret-123",
      },
    });
    assert.deepEqual(sanitized, {
      userSettings: {
        artifactReviewMode: "ARTIFACT_REVIEW_MODE_ALWAYS",
      },
    });
  });

  it("mergeAgyConfig and captureAgyConfig/applyAgyConfig round-trip without clobbering local state", () => {
    const tmp = makeTempDir();
    const machineA = path.join(tmp, "machineA-config.json");
    const repoSrc = path.join(tmp, "repo-agy");
    const machineB = path.join(tmp, "machineB-config.json");

    fs.writeFileSync(
      machineA,
      JSON.stringify({
        sidecars: { "swarm/swarm_board": { projectId: "proj-a" } },
        userSettings: {
          remoteControlHostname: "host-a",
          permissionPreset: "AGENT_PERMISSION_PRESET_TURBO",
        },
      }),
      "utf8"
    );

    assert.equal(captureAgyConfig({ srcDir: repoSrc, targetFile: machineA }).captured, true);
    const saved = JSON.parse(fs.readFileSync(path.join(repoSrc, "config.json"), "utf8"));
    assert.equal("sidecars" in saved, false);
    assert.equal("remoteControlHostname" in saved.userSettings, false);

    fs.writeFileSync(
      machineB,
      JSON.stringify({
        sidecars: { "swarm/swarm_board": { projectId: "proj-b" } },
        userSettings: {
          remoteControlHostname: "host-b",
          permissionPreset: "AGENT_PERMISSION_PRESET_DEFAULT",
        },
      }),
      "utf8"
    );

    assert.equal(applyAgyConfig({ srcDir: repoSrc, targetFile: machineB }).applied, true);
    const appliedB = JSON.parse(fs.readFileSync(machineB, "utf8"));
    assert.equal(appliedB.sidecars["swarm/swarm_board"].projectId, "proj-b");
    assert.equal(appliedB.userSettings.remoteControlHostname, "host-b");
    assert.equal(appliedB.userSettings.permissionPreset, "AGENT_PERMISSION_PRESET_TURBO");
  });
});
