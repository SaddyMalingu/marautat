/**
 * Generate worker-bundle/Alphadome.ico from the site logo.
 *
 *   node scripts/make_worker_icon.mjs
 *
 * Run once when the logo changes; the .ico is committed so the bundle build never needs the
 * source image or an image library. Asserts the container the Windows shell will read.
 */
import fs from 'fs';
import path from 'path';
import { pngToIco, icoSummary, pngSize } from '../utils/browserActor/workerIcon.js';

const argv = process.argv.slice(2);
const fromFlag = (() => {
  const at = argv.findIndex((a) => a === '--from' || a.startsWith('--from='));
  if (at === -1) return null;
  const token = argv[at];
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  return argv[at + 1] || null;
})();

const candidates = [
  // Produced by scripts/make_worker_icon.ps1 from the supplied artwork: already square and
  // already 256, so nothing here has to guess at aspect ratios.
  fromFlag,
  path.join(process.cwd(), 'worker-bundle', 'Alphadome-256.png'),
  path.join(process.cwd(), 'public', 'favicon.png'),
  path.join(process.cwd(), 'public', 'brand-logo-new.png')
].filter(Boolean);

const source = candidates.find((file) => fs.existsSync(file));
if (!source) {
  console.error('No logo found. Looked for:\n  ' + candidates.join('\n  '));
  console.error('\nProduce a square source first, on Windows:\n' +
    '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\make_worker_icon.ps1 -Source "<your logo.png>"');
  process.exit(2);
}
if (source.endsWith('.ico')) {
  console.error(source + ' is already an .ico — nothing to convert.');
  process.exit(2);
}

const png = fs.readFileSync(source);
const size = pngSize(png);
const ico = pngToIco(png);
const target = path.join(process.cwd(), 'worker-bundle', 'Alphadome.ico');
fs.writeFileSync(target, ico);

const summary = icoSummary(ico);
console.log(`source : ${path.relative(process.cwd(), source)} (${size.width}x${size.height}, ${png.length} bytes)`);
console.log(`target : ${path.relative(process.cwd(), target)} (${ico.length} bytes)`);
console.log(`header : type=${summary.type} images=${summary.count} payload=${summary.width}x${summary.height} isPng=${summary.payloadIsPng}`);

if (summary.type !== 1 || summary.count !== 1 || !summary.payloadIsPng) {
  console.error('Written file does not look like an icon the shell will accept.');
  process.exit(1);
}
