import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([".git", ".playwright-cli", "coverage", "data", "node_modules", "output", "outputs", "work"]);
const forbiddenNames = new Set([".env", ".DS_Store"]);
const forbiddenExtensions = new Set([".key", ".log", ".p12", ".pem", ".sqlite", ".sqlite-shm", ".sqlite-wal", ".zip"]);
const requiredFiles = ["AUTHORS.md", "CITATION.cff", "LICENSE", "PRIVACY.md", "SECURITY.md", ".env.example"];
const secretPatterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "personal absolute path", pattern: /\/Users\/(?!example(?:\/|$))[^/\s]+\// }
];

function workingTreeFiles(directory = root, prefix = "") {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) output.push(relative);
    else if (entry.isDirectory()) output.push(...workingTreeFiles(absolute, relative));
    else output.push(relative);
  }
  return output;
}

function candidateFiles() {
  const working = workingTreeFiles();
  try {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0").filter(Boolean);
    return [...new Set([...tracked, ...working])].sort();
  } catch {
    return working;
  }
}

const failures = [];
const files = candidateFiles();
for (const required of requiredFiles) {
  if (!files.includes(required) && !fs.existsSync(path.join(root, required))) failures.push(`missing required file: ${required}`);
}

for (const relative of files) {
  const normalized = relative.split(path.sep).join("/");
  const parts = normalized.split("/");
  const extension = path.extname(normalized);
  if (parts.some((part) => skippedDirectories.has(part))) failures.push(`private/generated directory is tracked: ${normalized}`);
  if (path.basename(normalized).startsWith(".env") && path.basename(normalized) !== ".env.example") failures.push(`private environment file is tracked: ${normalized}`);
  if (forbiddenNames.has(path.basename(normalized)) || forbiddenExtensions.has(extension)) failures.push(`private/generated file is tracked: ${normalized}`);
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    failures.push(`symbolic links are not allowed in the public tree: ${normalized}`);
    continue;
  }
  if (stat.size > 1_000_000) failures.push(`file exceeds 1 MB review limit: ${normalized}`);
  if (stat.size > 0 && stat.size <= 1_000_000) {
    const content = fs.readFileSync(absolute, "utf8");
    if (content.includes("\u0000")) continue;
    for (const check of secretPatterns) {
      if (check.pattern.test(content)) failures.push(`${check.name} found in ${normalized}`);
    }
  }
}

if (failures.length) {
  console.error("Public-tree check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Public-tree check passed for ${files.length} files.`);
}
