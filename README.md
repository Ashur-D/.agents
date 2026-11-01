# 🚀 Universal AI Skills & Harness Setup (`~/.agents`)

Follows the `agentskills.io` (`~/.agents/skills`) standard for **Pi Coding Agent**, **OpenCode**, **Antigravity (`agy`)**, and **T3 Code**.

## 📦 Architecture

```text
~/.agents/
├── harnesses.json       # Declarative registry of harnesses & skill discovery modes
├── skills/              # Canonical skills (~/.agents/skills — auto-discovered natively)
├── configs/
│   └── pi/              # Pi templates & custom-welcome extension
└── bin/
    ├── cli.mjs          # Cross-platform modular CLI
    ├── setup.sh         # Linux / macOS bootstrapper
    └── setup.ps1        # Windows bootstrapper
```

## 🧠 How Skill Discovery Works

- **Pi Coding Agent (`pi`)**: Natively scans `~/.agents/skills` out of the box (**0 symlinks**).
- **OpenCode (`opencode`)**: Configured via `"skills": ["~/.agents/skills"]` in `~/.config/opencode/opencode.json` (**0 symlinks**).
- **Antigravity (`agy`)**: Uses 1 compatibility symlink (`~/.gemini/config/skills -> ~/.agents/skills`).
- **T3 Code (`t3`)**: Automatically delegates to the active provider (`pi` or `agy`).

## ⚡ Quick Start

```bash
git clone https://github.com/Ashur-D/pi-agent.git ~/.agents
~/.agents/bin/setup.sh        # Windows: .\bin\setup.ps1
```

## 🛠️ CLI Commands

- `pi-setup` — Interactive menu (or `--apply`, `--only skills,t3`, `--only skills,pi`)
- `pi-doctor` — Health check for dependencies and all harness skill configurations
- `pi-update` — Update `~/.agents`, Pi CLI (`@earendil-works/pi-coding-agent`), and Pi extensions
- `pi-sync` — Sync `~/.agents/skills` and Pi settings to GitHub
