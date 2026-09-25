// Guard: a PowerShell script that contains non-ASCII must carry a UTF-8 BOM.
//
// Why it matters here: this project's only PowerShell is Windows PowerShell 5.1
// (`pwsh` is not installed), and 5.1 decodes a BOM-less script using the ANSI
// code page. Chinese comments/strings then turn into mojibake — and when a
// decoded byte lands on a quote, the file stops parsing altogether
// (`release-plugin-tarballs.ps1` failed with 14 syntax errors, so the release
// tool could not run at all). Every editor that rewrites the file without a BOM
// reintroduces the bug silently, so it is checked instead of remembered.
const fs = require("node:fs");
const path = require("node:path");

const scriptDir = __dirname;
const BOM = [0xef, 0xbb, 0xbf];

let checked = 0;
const problems = [];

for (const name of fs.readdirSync(scriptDir).filter((f) => f.endsWith(".ps1")).sort()) {
  const file = path.join(scriptDir, name);
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  const hasBom = bytes.length >= 3 && BOM.every((b, i) => bytes[i] === b);
  // ASCII-only scripts are safe either way (5.1's ANSI decode is lossless for them).
  if (!/[^\u0000-\u007f]/.test(text)) continue;
  checked += 1;
  if (!hasBom) problems.push(`${name}: contains non-ASCII but has no UTF-8 BOM (PowerShell 5.1 would mis-decode it)`);
}

if (problems.length > 0) {
  console.log("check-ps1-encoding: FAILED");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(`check-ps1-encoding: ${checked} non-ASCII script(s) carry a UTF-8 BOM`);
