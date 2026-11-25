// Builds a self-contained index.html from src/index.html.
// Every module the page imports (three + addons, followed recursively) is inlined into the
// import map as a data: URL. data: modules have no base URL, so relative imports inside the
// addons are rewritten to bare "three/addons/…" keys that the same import map resolves.
// The Baloo 2 font is inlined from vendor/ so the built page makes zero network requests.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const THREE_DIR = join(root, 'node_modules/three');
const ADDONS_DIR = join(THREE_DIR, 'examples/jsm');
const ADDON_PREFIX = 'three/addons/';

let html = readFileSync(join(root, 'src/index.html'), 'utf8');

const toDataUrl = (src) => 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
const IMPORT_RE = /(\bimport\s*(?:[^'"]*?\sfrom\s*)?|\bexport\s*[^'";]*?\sfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;

// ---- collect addon entry points used by the page
const pageModule = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!pageModule) throw new Error('no module script in src/index.html');
const entries = new Set();
for (const m of pageModule[1].matchAll(IMPORT_RE)) {
  const spec = m[3];
  if (spec.startsWith(ADDON_PREFIX)) entries.add(spec.slice(ADDON_PREFIX.length));
  else if (spec !== 'three') throw new Error(`unsupported import in page: ${spec}`);
}

// ---- walk addon graph, rewriting relative specifiers to bare keys
const modules = new Map();   // addon relative path -> rewritten source
function visit(rel) {
  if (modules.has(rel)) return;
  modules.set(rel, null);
  const src = readFileSync(join(ADDONS_DIR, rel), 'utf8');
  const out = src.replace(IMPORT_RE, (all, head, q, spec) => {
    if (spec === 'three') return all;
    if (spec.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(rel), spec));
      visit(target);
      return `${head}${q}${ADDON_PREFIX}${target}${q}`;
    }
    throw new Error(`unsupported import "${spec}" in ${rel}`);
  });
  modules.set(rel, out);
}
for (const e of entries) visit(e);

const imports = { three: toDataUrl(readFileSync(join(THREE_DIR, 'build/three.module.js'), 'utf8')) };
for (const [rel, src] of [...modules].sort()) imports[ADDON_PREFIX + rel] = toDataUrl(src);

html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/,
  `<script type="importmap">\n${JSON.stringify({ imports })}\n</script>`);

// ---- fonts: drop the Google Fonts links, inline the woff2
html = html.replace(/\s*<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/g, '');
const font = readFileSync(join(root, 'vendor/baloo2-700-latin.woff2')).toString('base64');
html = html.replace('<style>', `<style>
  @font-face { font-family: "Baloo 2"; font-style: normal; font-weight: 700; font-display: block;
    src: url(data:font/woff2;base64,${font}) format("woff2"); }`);

if (/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/[^"']*/g, ''))) {
  const hits = html.match(/https?:\/\/[^\s"'()]+/g).filter((u) => !u.startsWith('http://www.w3.org/'));
  if (hits.length) throw new Error('external URL left in build: ' + hits.slice(0, 5).join(', '));
}
writeFileSync(join(root, 'index.html'), html);
console.log(`index.html: ${(html.length / 1024).toFixed(0)} KiB, ${Object.keys(imports).length} modules inlined:`);
for (const k of Object.keys(imports)) console.log('  ' + k);
