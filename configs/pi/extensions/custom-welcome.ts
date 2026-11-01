import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

function center(text: string, width: number): string {
  const v = visibleWidth(text);
  const pad = Math.max(0, Math.floor((width - v) / 2));
  return " ".repeat(pad) + text;
}

function centerInWidth(text: string, targetWidth: number): string {
  const v = visibleWidth(text);
  if (v >= targetWidth) return text;
  const leftPad = Math.floor((targetWidth - v) / 2);
  const rightPad = targetWidth - v - leftPad;
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

function getPiVersion(): string {
  try {
    const candidates = [
      join(homedir(), ".local", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
      "/usr/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
      "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json"
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8"));
        if (pkg.version) return pkg.version;
      }
    }
  } catch {}
  return "1.4.0";
}

function padEndVisible(text: string, targetWidth: number): string {
  const v = visibleWidth(text);
  if (v >= targetWidth) return text;
  return text + " ".repeat(targetWidth - v);
}

function renderVerticalColumns(
  items: string[],
  numCols: number,
  termWidth: number,
  theme: Theme
): string[] {
  if (items.length === 0) return [];
  const numRows = Math.ceil(items.length / numCols);
  const cols: string[][] = [];
  for (let c = 0; c < numCols; c++) {
    cols.push(items.slice(c * numRows, (c + 1) * numRows));
  }

  const colWidths = cols.map((col) => {
    let max = 0;
    for (const item of col) {
      if (item) max = Math.max(max, visibleWidth(`• ${item}`));
    }
    return max;
  });

  const gap = "    ";
  const totalWidth =
    colWidths.reduce((a, b) => a + b, 0) + gap.length * (numCols - 1);
  const leftPad = " ".repeat(Math.max(0, Math.floor((termWidth - totalWidth) / 2)));

  const lines: string[] = [];
  for (let r = 0; r < numRows; r++) {
    let line = leftPad;
    for (let c = 0; c < numCols; c++) {
      const item = cols[c][r];
      if (item) {
        const itemStr = `${theme.fg("accent", "•")} ${theme.fg("text", item)}`;
        const padded =
          c === numCols - 1 ? itemStr : padEndVisible(itemStr, colWidths[c]);
        line += padded + (c === numCols - 1 ? "" : gap);
      }
    }
    lines.push(line);
  }
  return lines;
}

function renderSideBySide(
  skills: string[],
  packages: string[],
  width: number,
  theme: Theme
): string[] {
  const numSkillRows = Math.ceil(skills.length / 2);
  const sCol1 = skills.slice(0, numSkillRows);
  const sCol2 = skills.slice(numSkillRows);

  const sCol1Width = Math.max(1, ...sCol1.map((s) => visibleWidth(`• ${s}`)));
  const sCol2Width = Math.max(1, ...sCol2.map((s) => visibleWidth(`• ${s}`)));
  const skillGap = "    ";
  const skillsTotalWidth = sCol1Width + skillGap.length + sCol2Width;

  const extWidth = Math.max(
    1,
    ...packages.map((p) => visibleWidth(`• ${p}`)),
    visibleWidth(`Extensions · ${packages.length} active`)
  );
  const mainGap = "        ";

  const totalWidth = skillsTotalWidth + mainGap.length + extWidth;
  const leftPad = " ".repeat(Math.max(0, Math.floor((width - totalWidth) / 2)));

  const banner: string[] = [];
  const skillsHeader =
    theme.bold(theme.fg("accent", "Skills")) +
    theme.fg("dim", ` · ${skills.length} loaded`);
  const extHeader =
    theme.bold(theme.fg("accent", "Extensions")) +
    theme.fg("dim", ` · ${packages.length} active`);

  const headerLine =
    leftPad +
    centerInWidth(skillsHeader, skillsTotalWidth) +
    mainGap +
    centerInWidth(extHeader, extWidth);
  banner.push(headerLine);
  banner.push("");

  const maxRows = Math.max(numSkillRows, packages.length);
  for (let r = 0; r < maxRows; r++) {
    const s1 = sCol1[r] ? `${theme.fg("accent", "•")} ${theme.fg("text", sCol1[r])}` : "";
    const s2 = sCol2[r] ? `${theme.fg("accent", "•")} ${theme.fg("text", sCol2[r])}` : "";
    const ext = packages[r] ? `${theme.fg("accent", "•")} ${theme.fg("text", packages[r])}` : "";

    const skillsPart =
      padEndVisible(s1, sCol1Width) + skillGap + padEndVisible(s2, sCol2Width);
    const line = leftPad + skillsPart + mainGap + ext;
    banner.push(line);
  }
  return banner;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme: Theme) => {
      const home = homedir();
      const piVersion = getPiVersion();

      // ─── Loaded Skills ──────────────────────────────────────────────
      const userSkillsDir = join(home, ".pi", "agent", "skills");
      let skills: string[] = [];
      if (existsSync(userSkillsDir)) {
        try {
          skills = readdirSync(userSkillsDir)
            .filter((f) => {
              try {
                return statSync(join(userSkillsDir, f)).isDirectory();
              } catch {
                return false;
              }
            })
            .sort();
        } catch {
          skills = [];
        }
      }

      // ─── Loaded Extensions ──────────────────────────────────────────
      const settingsPath = join(home, ".pi", "agent", "settings.json");
      let packages: string[] = [];
      if (existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
          packages = (settings.packages || [])
            .map((p: string) =>
              p.replace(/^npm:/, "").replace(/^@[\w-]+\//, "")
            )
            .sort();
        } catch {
          packages = [];
        }
      }

      return {
        render(width: number): string[] {
          const now = new Date();
          const dateStr = now.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          });
          const timeStr = now.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          });
          const banner: string[] = [];
          banner.push("");

          // ─── Header: Clean Typography ──────────────────────────────────────
          const title = "✦  P I  ✦";
          banner.push(center(theme.bold(theme.fg("accent", title)), width));
          banner.push("");

          // ─── Badges: Punchy & Centered ─────────────────────────────────────
          const badges = theme.fg(
            "text",
            `Pi v${piVersion}  ·  Auth Ready  ·  ${dateStr} · ${timeStr}`
          );
          banner.push(center(badges, width));
          banner.push("");

          // ─── Skills & Extensions Section ──────────────────────────────────
          if (width >= 96 && skills.length > 0 && packages.length > 0) {
            // Side-by-side at the same height on wide screens
            const sideBySideLines = renderSideBySide(skills, packages, width, theme);
            banner.push(...sideBySideLines);
            banner.push("");
          } else {
            // Fallback for narrower screens (< 96 cols)
            if (skills.length > 0) {
              const skillsHeader =
                theme.bold(theme.fg("accent", "Skills")) +
                theme.fg("dim", ` · ${skills.length} loaded`);
              banner.push(center(skillsHeader, width));
              banner.push("");

              const skillLines = renderVerticalColumns(skills, 2, width, theme);
              banner.push(...skillLines);
              banner.push("");
            }

            if (packages.length > 0) {
              const extHeader =
                theme.bold(theme.fg("accent", "Extensions")) +
                theme.fg("dim", ` · ${packages.length} active`);
              banner.push(center(extHeader, width));
              banner.push("");

              const extLines = renderVerticalColumns(packages, 2, width, theme);
              banner.push(...extLines);
              banner.push("");
            }
          }

          return banner;
        },
        invalidate() {},
      };
    });
  });
}
