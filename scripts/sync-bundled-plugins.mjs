// Mirror the plugin source repositories into this repo's plugins/ directory.
//
// The four bundled plugins live in their own git repositories (they are also
// published as standalone packages for other DSH hosts); this app ships a COPY of
// each inside app.asar. Keeping that copy in step by hand is how "the app has an
// old version of the plugin" bugs happen, so it is generated:
//
//     plugin-repos/<pkg>/**  ->  plugins/<pkg>/**
//
// The source of truth is always the plugin repository. This script mirrors its
// TRACKED files (plus untracked-but-not-ignored ones, which it lists explicitly)
// from the WORKING TREE — so an uncommitted fix is picked up too — deletes files
// in the target that no longer exist in the source, and preserves the target's
// line-ending convention (a Windows checkout keeps CRLF; nothing churns).
//
// It is wired into the `dist:*` builds (`npm run sync:plugins` runs first), so a
// release can never ship a stale plugin. `--check` reports drift without writing.
//
// Where the sources are: <repo>/../plugin-repos/<pkg> by default — i.e. the
// dsh-dev workspace layout (dsh-dev/dsh-ready-gui + dsh-dev/plugin-repos). The
// older sibling layout (<repo>/../<pkg>) and a nested one (<repo>/plugin-repos)
// are also tried, and DSH_PLUGIN_REPOS / --repos override everything, so the
// script keeps working from wherever the repos happen to live.
//
// Usage:
//   node scripts/sync-bundled-plugins.mjs                 # mirror + report
//   node scripts/sync-bundled-plugins.mjs --check         # report only (exit 1 on drift)
//   node scripts/sync-bundled-plugins.mjs --strict        # missing sources are an error
//   node scripts/sync-bundled-plugins.mjs --only dsh-keys-setting
//   node scripts/sync-bundled-plugins.mjs --repos D:\somewhere\plugin-repos
//
// When the sources cannot be found but plugins/ already holds a copy (a CI checkout
// of this repository alone), the run degrades to "skip" instead of failing — the
// dist:* scripts call this before every build, and a missing source repository must
// not break them. --strict turns that back into an error.
"use strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CHECK_ONLY = flag("--check");
const STRICT = flag("--strict");
const ONLY = value("--only");
const REPOS_ARG = value("--repos") ?? process.env.DSH_PLUGIN_REPOS;

// The plugin list comes from the app's own catalog, so a newly added built-in
// plugin cannot be forgotten here.
const { CATALOG } = require(path.join(REPO, "src", "plugin-manager.js"));
const BUNDLED = CATALOG.filter((entry) => entry.localSource);

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Candidate directories that may hold the plugin repositories.
 *
 * Discovered rather than hard-coded, because the repos legitimately live in
 * several shapes while the workspace is being reorganised:
 *   <repo>/plugin-repos                     nested in this repo
 *   <repo>/../plugin-repos                  dsh-dev/{dsh-ready-gui,plugin-repos}
 *   <repo>/..                               flat siblings of this repo
 *   <repo>/../<any dir>/plugin-repos        a workspace that holds both
 * DSH_PLUGIN_REPOS / --repos skips all of this.
 */
function sourceRoots() {
  if (REPOS_ARG) return [path.resolve(REPOS_ARG)];
  const found = [];
  const add = (dir) => {
    if (!found.includes(dir)) found.push(dir);
  };
  for (const base of [REPO, path.join(REPO, "..")]) {
    add(path.join(base, "plugin-repos"));
    add(base);
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      /* unreadable base: nothing to discover */
    }
    for (const item of entries) {
      if (item.isDirectory()) add(path.join(base, item.name, "plugin-repos"));
    }
  }
  return found;
}

const roots = sourceRoots();
const isRepo = (dir) => fs.existsSync(path.join(dir, ".git"));

/** Resolve the source repository for one catalog entry. */
function findSource(entry) {
  for (const root of roots) {
    const dir = path.join(root, entry.localSource);
    if (isRepo(dir)) return dir;
  }
  return null;
}

/** Tracked files + untracked-but-not-ignored files, relative and POSIX-style. */
function sourceFiles(dir) {
  const rel = (list) =>
    list
      .split("\0")
      .filter(Boolean)
      .map((p) => p.split(path.sep).join("/"));
  const tracked = rel(git(dir, ["ls-files", "-z"]));
  const untracked = rel(git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return { tracked, untracked, all: [...new Set([...tracked, ...untracked])].sort() };
}

/** Every file currently in the target directory (relative, POSIX-style). */
function targetFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current, prefix) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * Keep the target's line-ending convention, uniformly.
 *
 * The plugin repos are LF; a Windows checkout of this repo is CRLF
 * (core.autocrlf), and its committed blobs are CRLF too. Adapting means a sync of
 * unchanged content writes nothing and `git status` stays clean — and it must
 * produce a UNIFORM file, because normalising only *some* lines (which is what
 * "only convert when the text has no CRLF yet" does to a source whose last line
 * carries a stray CRLF) leaves a mixed file that git keeps reporting as modified
 * while `git diff` shows nothing.
 */
function adaptEol(text, targetText) {
  if (targetText === undefined) return text; // new file: keep the source bytes
  const lf = text.replace(/\r\n/g, "\n");
  return targetText.includes("\r\n") ? lf.replace(/\n/g, "\r\n") : lf;
}

function syncOne(entry) {
  const source = findSource(entry);
  const target = path.join(REPO, "plugins", entry.localSource);
  if (source === null) {
    // 找不到插件仓库：CI 只 checkout 本仓库，这是**正常**情况（插件源在各自仓库里）。
    // 只要 plugins/ 里已经有一份随包副本就降级为「跳过」，而不是让整个构建失败 ——
    // 否则 dist:* 前置的同步会让 CI 的每一个矩阵任务第一步就挂掉。--strict 时仍然
    // 视为错误（本地/发布前用它确认源确实在）。
    const existing = fs.existsSync(path.join(target, "package.json"));
    if (existing && !STRICT) {
      return { entry, source: null, skipped: `no plugin repository found under: ${roots.join(", ")}` };
    }
    return { entry, source: null, error: `no plugin repository found under: ${roots.join(", ")}` };
  }

  const { tracked, untracked, all } = sourceFiles(source);
  const before = targetFiles(target);
  const report = { entry, source, target, added: [], changed: [], removed: [], eolOnly: [], same: 0, warnings: [] };

  for (const rel of all) {
    const from = path.join(source, rel);
    if (!fs.existsSync(from)) {
      report.warnings.push(`${rel}: listed by git but missing on disk`);
      continue;
    }
    const to = path.join(target, rel);
    const raw = fs.readFileSync(from);
    const previous = fs.existsSync(to) ? fs.readFileSync(to) : undefined;
    const binary = raw.includes(0);
    const next = binary ? raw : Buffer.from(adaptEol(raw.toString("utf8"), previous?.toString("utf8")), "utf8");
    if (previous !== undefined && previous.equals(next)) {
      report.same += 1;
      continue;
    }
    const bucket = previous === undefined ? report.added : report.changed;
    if (previous !== undefined && previous.toString("utf8").replace(/\r\n/g, "\n") === raw.toString("utf8").replace(/\r\n/g, "\n")) {
      report.eolOnly.push(rel);
    }
    bucket.push(rel);
    if (!CHECK_ONLY) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, next);
    }
  }

  for (const rel of before) {
    if (all.includes(rel)) continue;
    report.removed.push(rel);
    if (!CHECK_ONLY) fs.rmSync(path.join(target, rel), { force: true });
  }

  if (untracked.length > 0) {
    report.warnings.push(`not tracked by git (synced anyway): ${untracked.join(", ")}`);
  }

  // A bundled plugin must be installable by the engine: a bundle patch and a
  // resolved name/version. Catch it here rather than at boot.
  const pkgPath = path.join(source, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.name !== entry.pkg) report.warnings.push(`package.json name "${pkg.name}" != catalog pkg "${entry.pkg}"`);
    if (!pkg.version) report.warnings.push("package.json has no version");
    if (pkg.dsh?.bundle?.patch === undefined) report.warnings.push("package.json declares no dsh.bundle.patch");
    report.version = pkg.version;
  } catch (error) {
    report.warnings.push(`package.json unreadable: ${error.message}`);
  }
  if (!fs.existsSync(path.join(source, "cordis.patch.yml"))) report.warnings.push("cordis.patch.yml is missing");

  // Every plugin documents itself in Chinese (README.md, the default GitHub shows)
  // and English (README.en.md), and the two link to each other. Losing one of them
  // is silent otherwise: the repo just looks monolingual again.
  const bilingual = ["README.md", "README.en.md"];
  const readmes = new Map();
  for (const doc of bilingual) {
    const file = path.join(source, doc);
    if (!fs.existsSync(file)) report.warnings.push(`${doc} is missing (both language versions are required)`);
    else readmes.set(doc, fs.readFileSync(file, "utf8"));
  }
  for (const doc of bilingual) {
    const other = bilingual.find((name) => name !== doc);
    if (readmes.has(doc) && readmes.has(other) && !readmes.get(doc).includes(other)) {
      report.warnings.push(`${doc} does not link to ${other} (language switcher)`);
    }
  }

  report.total = all.length;
  return report;
}
const selected = ONLY ? BUNDLED.filter((entry) => entry.pkg === ONLY || entry.localSource === ONLY) : BUNDLED;
if (selected.length === 0) {
  console.error(`--only ${ONLY} matched no bundled plugin (have: ${BUNDLED.map((e) => e.pkg).join(", ")})`);
  process.exit(2);
}

console.log(`sync:plugins${CHECK_ONLY ? " (check only)" : ""}`);
const existingRoots = roots.filter((dir) => fs.existsSync(dir));
if (existingRoots.length > 0) console.log(`  plugin sources: ${existingRoots.join("  |  ")}`);
let drift = 0;
let failed = 0;

for (const entry of selected) {
  const report = syncOne(entry);
  if (report.error) {
    failed += 1;
    console.log(`\n✗ ${entry.pkg}: ${report.error}`);
    continue;
  }
  if (report.skipped) {
    console.log(`\n~ ${entry.pkg}: skipped — ${report.skipped}`);
    console.log("    (keeping the copy already in plugins/; use --strict to require the sources)");
    continue;
  }
  const changed = report.added.length + report.changed.length + report.removed.length;
  drift += changed;
  const mark = changed === 0 ? "=" : CHECK_ONLY ? "!" : "+";
  console.log(`\n${mark} ${entry.pkg}  v${report.version ?? "?"}  (${report.total} files)`);
  console.log(`    source: ${report.source}`);
  if (changed === 0) {
    console.log(`    up to date (${report.same} unchanged)`);
  } else {
    const detail = (label, list) => (list.length > 0 ? `${label}: ${list.join(", ")}` : "");
    for (const line of [
      detail("added", report.added),
      detail("updated", report.changed),
      detail("removed", report.removed),
    ]) {
      if (line) console.log(`    ${line}`);
    }
    if (report.eolOnly.length > 0) {
      console.log(`    (${report.eolOnly.length} of them were line-ending differences only)`);
    }
    console.log(CHECK_ONLY ? "    -> would be updated" : "    -> mirrored");
  }
  for (const warning of report.warnings) console.log(`    ! ${warning}`);
}

console.log("");
if (failed > 0) {
  console.error(`sync:plugins failed for ${failed} plugin(s)`);
  process.exit(2);
}
if (CHECK_ONLY && drift > 0) {
  console.error(`sync:plugins: plugins/ is out of date (${drift} file(s)); run: npm run sync:plugins`);
  process.exit(1);
}
if (drift > 0 && !CHECK_ONLY) {
  console.log(`sync:plugins done — ${drift} file(s) written. Commit plugins/ together with the plugin repo change.`);
}
if (drift === 0) console.log("sync:plugins: everything already in sync");
