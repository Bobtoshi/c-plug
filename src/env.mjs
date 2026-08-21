import fs from "node:fs";

function assertPrivateFile(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("The private environment path must be a regular file.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("The private environment file must be owned by the current user.");
  if ((stat.mode & 0o077) !== 0) throw new Error("The private environment file must be owner-only. Run: chmod 600 .env");
}

export function loadEnv(filename) {
  if (!fs.existsSync(filename)) return;
  assertPrivateFile(filename);
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
