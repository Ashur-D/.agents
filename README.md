# 🚀 Universal AI Skills & Harness Setup (`~/.agents`)

Follows the `agentskills.io` (`~/.agents/skills`) standard for **Pi Coding Agent**, **OpenCode**, **Antigravity (`agy`)**, and **T3 Code**.

## 📦 Architecture

```text
~/.agents/
├── harnesses.json       # Declarative registry of harnesses, T3 Code config & skill modes
├── skills/              # Canonical skills (~/.agents/skills — auto-discovered natively)
├── configs/
│   ├── pi/              # Pi templates & custom-welcome extension
│   └── t3/              # T3 Code settings, client preferences, keybindings & themes
└── bin/
    ├── cli.mjs          # Cross-platform modular CLI
    ├── setup.sh         # Linux / macOS bootstrapper (prompts to install node/npm if missing)
    └── setup.ps1        # Windows bootstrapper (prompts to install node/npm if missing)
```

## 🧠 How Skill Discovery Works

- **Pi Coding Agent (`pi`)**: Natively scans `~/.agents/skills` out of the box (**0 symlinks**).
- **OpenCode (`opencode`)**: Configured via `"skills": ["~/.agents/skills"]` in `~/.config/opencode/opencode.json` (**0 symlinks**).
- **Antigravity (`agy`)**: Uses 1 compatibility symlink (`~/.gemini/config/skills -> ~/.agents/skills`).
- **T3 Code (`t3`)**: Automatically delegates to the active provider (`pi` or `agy`).

## ⚡ Quick Start

```bash
git clone https://github.com/Ashur-D/.agents.git ~/.agents
~/.agents/bin/setup.sh        # Windows: .\bin\setup.ps1
```

## 🛠️ CLI Commands

- `agents` — Interactive menu
- `agents setup` — Install & configure modules (`--only skills,t3`, `--only skills,pi`)
- `agents apply` — Configure skills and apply Pi & T3 Code configs without installing packages
- `agents doctor` — Health check for dependencies, T3 Code config, and all harness skill configurations
- `agents update` — Update `~/.agents`, Pi CLI, and Pi extensions
- `agents sync` — Sync `~/.agents/skills`, Pi settings, and T3 Code configs to GitHub

## 📚 Installed Skills & Sources

Skills remain flat under `skills/<name>/SKILL.md` for `agentskills.io` and harness compatibility, grouped here by upstream creator:

| Creator / Repo | Skills |
| :--- | :--- |
| **Custom** | `tech-ethics-writer` |
| [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack/skills) (`pstack`) | `teach`, `how`, `why`, `technical-writing`, `unslop` |
| [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills) | `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `writing-skills` |
| [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills) | `grilling`, `improve-codebase-architecture`, `triage` |
| [t3dotgg/tstack](https://github.com/t3dotgg/tstack/tree/main/skills) | `council`, `file-pr`, `modernize`, `leaving-pr-comments` |
| [obsidianmd/obsidian-skills](https://github.com/obsidianmd/obsidian-skills/tree/main/plugins/obsidian/skills) | `defuddle`, `json-canvas`, `knap`, `obsidian-bases`, `obsidian-cli`, `obsidian-markdown` |
| [affaan-m/ECC](https://github.com/affaan-m/ECC/tree/main/skills) | `search-first`, `security-review`, `cisco-ios-patterns`, `netmiko-ssh-automation`, `network-bgp-diagnostics`, `network-config-validation`, `network-interface-health`, `homelab-network-readiness`, `homelab-network-setup`, `homelab-vlan-segmentation` |
| [blader/humanizer](https://github.com/blader/humanizer) | `humanizer` |
| [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd/tree/main/skills/i-have-adhd) | `i-have-adhd` |
| [nykooi1/vibe-wise](https://github.com/nykooi1/vibe-wise) | `vibe-wise` |
