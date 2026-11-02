// End-to-end smoke test: starts the built server over stdio and exercises every tool.
// Run with:  npm run build && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// connect once at module load (top-level await) - before/after hooks keep Node 18's runner from exiting on Windows
const client = new Client({ name: 'smoke-test', version: '0.0.1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'index.js')], cwd: root, stderr: 'pipe' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} returned error: ${JSON.stringify(r.content).slice(0, 300)}`);
  return r;
};
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const parse = (r) => JSON.parse(textOf(r));

test('lists tools, resources and prompts', async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['machine_overview', 'search', 'get_page', 'get_page_image', 'get_axis', 'get_drive_parameters', 'compare_drive_parameters', 'explain_drive_parameter', 'get_plc_io', 'find_component', 'search_parts', 'get_pump_info', 'nozzle_flow', 'get_procedure', 'get_drawing', 'find_sheet']) {
    assert.ok(tools.includes(t), `missing tool ${t}`);
  }
  const resources = (await client.listResources()).resources;
  assert.ok(resources.some((r) => r.uri === 'waterjet://docs/ptv-electrical'));
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.ok(prompts.includes('troubleshoot') && prompts.includes('plan-hardware-addition'));
});

test('machine overview and catalogue', async () => {
  const o = parse(await call('machine_overview'));
  assert.equal(o.machine.type, 'WJ3020B 1Z-PJ-NL');
  const docs = parse(await call('list_documents'));
  assert.ok(docs.length >= 17);
  assert.ok(docs.find((d) => d.id === 'pump-manual').pages === 82);
});

test('search finds schematic designators and pump topics', async () => {
  const hits = parse(await call('search', { query: 'XPS-AC5121', limit: 5 }));
  assert.ok(hits.some((h) => h.doc_id === 'ptv-electrical' && h.page === 23), JSON.stringify(hits));
  const hits2 = parse(await call('search', { query: 'bleed down valve temperature', doc_id: 'pump-manual' }));
  assert.ok(hits2.length > 0);
  const hits3 = parse(await call('search', { query: 'SQ14' }));
  assert.ok(hits3.some((h) => h.doc_id === 'ptv-electrical' && h.page === 36));
});

test('page text and image', async () => {
  const p = textOf(await call('get_page', { doc_id: 'pump-manual', page: 3 }));
  assert.match(p, /4100 bar/);
  const img = await call('get_page_image', { doc_id: 'ptv-electrical', page: 43 });
  const image = img.content.find((c) => c.type === 'image');
  assert.ok(image && image.mimeType === 'image/png' && image.data.length > 10000);
  const sheets = parse(await call('find_sheet', { query: 'drive Z1' }));
  assert.ok(sheets.some((s) => s.page === 46));
});

test('axes and drives', async () => {
  const z = parse(await call('get_axis', { axis: 'Z1' }));
  assert.match(z.motor.model, /AKM24C/);
  assert.equal(z.drive_parameter_summary.key_parameters.MBRAKE, '1');
  const p = parse(await call('get_drive_parameters', { axis: 'X', names: ['GP', 'GV', 'GVTN', 'OPMODE'] }));
  assert.equal(p.parameters.GP.value, '0.01');
  assert.equal(p.parameters.OPMODE.value, '8');
  const cmp = parse(await call('compare_drive_parameters', { axis_a: 'X', axis_b: 'Y1' }));
  assert.equal(cmp.differing_parameters, 3); // ALIAS, DIR, GP
  const ex = parse(await call('explain_drive_parameter', { name: 'IN3MODE' }));
  assert.equal(ex.values_per_axis.Z, '2');
  const raw = textOf(await call('get_drive_parameters', { axis: 'B1', raw: true }));
  assert.match(raw, /ALIAS B1/);
});

test('plc, components, parts', async () => {
  const a2 = parse(await call('get_plc_io', { module: 'A2' }));
  assert.equal(a2.digital_outputs[1].io, 'DO 1.1');
  const c = parse(await call('find_component', { query: 'KM1' }));
  assert.ok(c.matches.some((m) => m.ref.includes('KM1')));
  const parts = parse(await call('search_parts', { query: '302001' }));
  assert.ok(parts.items.some((i) => i.order_no.startsWith('302001')));
});

test('pump info, nozzle flow, procedures, drawings', async () => {
  const pump = parse(await call('get_pump_info', { section: 'service_intervals' }));
  assert.equal(pump.service_intervals.check_valves_lapping_Mth, 500);
  const n = parse(await call('nozzle_flow', { orifice_thou: [14], pressure_bar: 3800 }));
  assert.ok(n.total_flow_l_min > 3.5 && n.total_flow_l_min < 3.8, JSON.stringify(n.orifices));
  const n2 = parse(await call('nozzle_flow', { orifice_thou: [15, 10], pressure_psi: 60000 }));
  assert.equal(n2.within_pump_capacity, false);
  const proc = parse(await call('get_procedure', { id: 'portal alignment' }));
  assert.equal(proc.id, 'portal-alignment');
  const dr = await call('get_drawing', { id: 'height-sensor-arm' });
  assert.ok(dr.content.some((c) => c.type === 'image'));
  const imgs = await call('get_document_images', { doc_id: 'procedure-portal-alignment', max_images: 2 });
  assert.equal(imgs.content.filter((c) => c.type === 'image').length, 2);
});

test('resources', async () => {
  const r = await client.readResource({ uri: 'waterjet://drives/Z' });
  assert.match(r.contents[0].text, /MNAME AKM24C/);
  const p = await client.readResource({ uri: 'waterjet://pages/pump-manual/54' });
  assert.equal(p.contents[0].mimeType, 'image/png');
});

test('shutdown', async () => {
  await client.close();
  // give the reporter a moment to flush the summary, then end the process explicitly
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
