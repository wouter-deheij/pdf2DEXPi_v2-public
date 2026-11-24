// Builds the public copy of this repository in OUT_DIR: every file tracked in git at HEAD, minus the
// client drawings, answer keys and other private paths, with client and project names rewritten.
// Fails (exit 1) when a forbidden name is still found anywhere in the copy.
//
//   node scripts/public-export.mjs OUT_DIR
//
// Used by .github/workflows/public-mirror.yml; run it locally to see exactly what would be published.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: node scripts/public-export.mjs OUT_DIR");
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "public-export.json"), "utf8"));
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

const tracked = git("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
const excluded = (f) => cfg.exclude.some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e));

// project names from the private drawings: the full name becomes its leading code
// (R10-011 → R10-011), longest first so no name is half-replaced
const stems = new Set();
for (const f of tracked) {
  const m = f.match(/^(?:input\/(.+)\.pdf|reference\/keys\/(.+)\.key\.json)$/);
  if (m) stems.add(m[1] ?? m[2]);
}
const replace = { ...cfg.replace };
for (const s of stems) {
  const code = s.match(/^[A-Za-z]+[-_]?\d+(?:-\d+)?/)?.[0] ?? s;
  if (code !== s) replace[s] ??= code;
}
const pairs = Object.entries(replace).sort((a, b) => b[0].length - a[0].length);
const forbidden = [...cfg.forbidden, ...[...stems].filter((s) => replace[s])].map((w) => w.toLowerCase());

const isText = (buf) => !buf.subarray(0, 8000).includes(0);
fs.rmSync(OUT, { recursive: true, force: true });
let copied = 0, rewritten = 0;
const hits = [];
for (const f of tracked) {
  if (excluded(f)) continue;
  let buf = execFileSync("git", ["show", `HEAD:${f}`], { cwd: ROOT, maxBuffer: 1 << 28 });
  if (isText(buf)) {
    let s = buf.toString("utf8");
    const before = s;
    for (const [from, to] of pairs) s = s.split(from).join(to);
    if (s !== before) rewritten++;
    const low = s.toLowerCase();
    for (const w of forbidden) {
      const i = low.indexOf(w);
      if (i >= 0) hits.push(`${f}: "${s.slice(Math.max(0, i - 30), i + w.length + 30).replace(/\s+/g, " ")}"`);
    }
    buf = Buffer.from(s, "utf8");
  } else if (forbidden.some((w) => buf.toString("latin1").toLowerCase().includes(w))) {
    hits.push(`${f}: binary file contains a forbidden name`);
  }
  const dst = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
  copied++;
}
if (hits.length) {
  console.error(`✗ forbidden names left in the public copy (add a "replace" rule or an "exclude" path in scripts/public-export.json):\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ public copy in ${OUT}: ${copied} files (${rewritten} rewritten), ${tracked.length - copied} left out`);
