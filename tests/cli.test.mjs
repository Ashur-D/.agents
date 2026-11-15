import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  configureHarnessSkills,
  ensureCanonicalSkillsRoot,
  mergePiSettings,
  parseHarnessSelection,
} from "../bin/cli.mjs";

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
  it("harnesses.json is valid and declares harnesses", () => {
    const raw = fs.readFileSync(path.join(REPO_DIR, "harnesses.json"), "utf8");
    const cfg = JSON.parse(raw);
    assert.equal(typeof cfg.skillsRoot, "string");
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
