// Convert the DWG drawings to DXF + metadata JSON using the LibreDWG WebAssembly build.
// Usage: node scripts/dwg_convert.mjs <dwg-dir> <out-dir>     (needs: npm install @mlightcad/libredwg-web)
// Afterwards run: python scripts/render_dxf.py <out-dir>      to get PNG renders.
import { LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [, , srcDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const require = createRequire(import.meta.url);
// resolve the package directory via its main entry (package.json is not exported)
const pkgDir = require.resolve('@mlightcad/libredwg-web').replace(/[\\/]dist[\\/].*$/, '');
const wasmDir = path.join(pkgDir, 'wasm/');
const lib = await LibreDwg.create(wasmDir);

for (const f of fs.readdirSync(srcDir).filter((n) => n.toLowerCase().endsWith('.dwg'))) {
  const buf = fs.readFileSync(path.join(srcDir, f));
  const base = f.replace(/\.dwg$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const ptr = lib.dwg_read_data(ab, Dwg_File_Type.DWG);
    if (!ptr) { console.log(f, 'read failed'); continue; }
    const ver = lib.dwg_get_version_type(ptr);
    const db = lib.convert(ptr);
    try { fs.writeFileSync(path.join(outDir, base + '.svg'), lib.dwg_to_svg(db)); } catch (e) { console.log(f, 'svg failed', e.message); }
    const texts = [];
    for (const e of db.entities || []) {
      if (['TEXT', 'MTEXT', 'ATTRIB'].includes(e.type)) {
        texts.push(String(e.text ?? e.textString ?? '').replace(/\\[A-Za-z][^;]*;|[{}]/g, '').trim());
      }
    }
    const counts = {};
    for (const e of db.entities || []) counts[e.type] = (counts[e.type] || 0) + 1;
    const layers = (db.tables?.LAYER?.entries || []).map((l) => l.name);
    fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify({ file: f, version: ver, layers, entity_counts: counts, texts: texts.filter(Boolean) }, null, 1));
    lib.dwg_free(ptr);
    console.log(f, ver.description, 'entities', (db.entities || []).length);
  } catch (e) {
    console.log(f, 'ERROR', e.message);
  }
}
// Second pass: DXF export. (Mixing dwg_write_dxf with dwg_read_data on the same module instance corrupts its state.)
for (const f of fs.readdirSync(srcDir).filter((n) => n.toLowerCase().endsWith('.dwg'))) {
  const buf = fs.readFileSync(path.join(srcDir, f));
  const base = f.replace(/\.dwg$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const dxf = lib.dwg_write_dxf(ab);
    if (dxf) { fs.writeFileSync(path.join(outDir, base + '.dxf'), Buffer.from(dxf)); console.log(f, 'dxf', dxf.length, 'bytes'); }
  } catch (e) { console.log(f, 'DXF ERROR', e.message); }
}
