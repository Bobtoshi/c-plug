import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, ".env.example");
const target = path.join(root, ".env");

if (fs.existsSync(target)) {
  fs.chmodSync(target, 0o600);
  console.log("Existing .env kept and restricted to the current user (mode 600).");
} else {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
  console.log("Created owner-only .env. Add your provider, model, and API key, then run npm start.");
}
