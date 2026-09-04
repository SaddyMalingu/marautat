import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const root = resolve(__dirname, "..");
const from = resolve(root, "src", "api", "static");
const to = resolve(root, "dist", "api", "static");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true, force: true });

console.log("[build] copied static assets to dist/api/static");
