# 🚀 Universal AI Skills & Harness Setup (`~/agents`)

Modular configuration, shared skills (`~/skills`), and setup manager for **Antigravity (`agy`)**, **OpenCode**, **Pi Coding Agent**, and **T3 Code**.

## 📦 Architecture

```text
~/agents/
├── harnesses.json       # Declarative registry of harnesses & skill symlink targets
├── skills/              # Canonical skills (linked to ~/skills and all harnesses)
├── configs/
│   └── pi/              # Pi templates & custom-welcome extension
└── bin/
    ├── cli.mjs          # Cross-platform modular CLI
    ├── setup.sh         # Linux / macOS bootstrapper
    └── setup.ps1        # Windows bootstrapper
```

## ⚡ Quick Start

```bash
git clone https://github.com/Ashur-D/pi-agent.git ~/agents
~/agents/bin/setup.sh        # Windows: .\bin\setup.ps1
```

## 🛠️ CLI Commands

- `pi-setup` — Interactive menu (or `--apply`, `--only skills,t3`, `--only skills,pi`)
- `pi-doctor` — Health check for dependencies and all harness skill symlinks
- `pi-update` — Update `~/agents`, Pi CLI (`@earendil-works/pi-coding-agent`), and Pi extensions
- `pi-sync` — Sync `~/skills` and Pi settings to GitHub

## 🔌 Adding or Removing a Harness

Edit [`harnesses.json`](./harnesses.json) to add or remove any harness skill path, then run:

```bash
pi-setup --apply --only skills
```
