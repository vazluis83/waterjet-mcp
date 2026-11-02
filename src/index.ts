#!/usr/bin/env node
/**
 * waterjet-mcp - Model Context Protocol server for the AMC water jet cutting machine
 * (PTV WJ3020B 1Z-PJ-NL table + JETS 3.8/60-COMPACT pump).
 *
 * Transport: stdio.  Knowledge folder: ./knowledge (or $WATERJET_KB).
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import { KnowledgeBase } from './kb.js';
import { registerTools } from './tools.js';

const kb = new KnowledgeBase();

const server = new McpServer(
  { name: 'waterjet-mcp', version: '0.1.0' },
  {
    instructions: [
      'This server holds the technical documentation of one water jet cutting installation operated by AMC (A. Moreira Cadete, Lda.):',
      'a PTV WJ3020B 1Z-PJ-NL CNC cutting table with Cnc886 control, Kollmorgen SERVOSTAR 600 servo drives and Elsaco CAN I/O,',
      'and a PTV JETS 3.8/60-COMPACT 4100 bar pump with an H2O Jet 60K intensifier.',
      'Start with machine_overview. Use search for anything (designators, part numbers, signals), then get_page / get_page_image to read the',
      'actual schematic sheet - the sheet text alone is only a list of labels. get_axis, get_plc_io and find_component answer wiring questions;',
      'get_drive_parameters / compare_drive_parameters / explain_drive_parameter cover the servo drives; get_pump_info, nozzle_flow,',
      'get_procedure and search_parts cover the pump and its maintenance.',
      'Safety: the pump runs at 4100 bar and the drives have 600 V DC buses - always quote the lock-out / bleed-down steps from the procedures.',
      'Drive parameter meanings marked medium/low confidence must be verified against the Kollmorgen ASCII reference before changing a drive.',
    ].join(' '),
  },
);

registerTools(server, kb);

// ---- resources: documents, pages and drawings ---------------------------------------------------
server.registerResource(
  'document-text',
  new ResourceTemplate('waterjet://docs/{doc_id}', {
    list: async () => ({
      resources: kb.catalog.map((d) => ({ uri: `waterjet://docs/${d.id}`, name: d.title, description: `${d.kind}, ${d.pages} page(s), ${d.source_file}`, mimeType: 'text/plain' })),
    }),
  }),
  { title: 'Document text', description: 'Full extracted text of a document, page by page', mimeType: 'text/plain' },
  async (uri, { doc_id }) => {
    const id = kb.resolveDocId(String(doc_id));
    const doc = id ? kb.getDoc(id) : undefined;
    if (!doc) return { contents: [{ uri: uri.href, text: `Unknown document ${doc_id}` }] };
    const body = doc.pages_content.map((p) => `===== ${doc.id} page ${p.page} =====\n${p.text}`).join('\n\n');
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: `# ${doc.title}\n\n${body}` }] };
  },
);

server.registerResource(
  'page-image',
  new ResourceTemplate('waterjet://pages/{doc_id}/{page}', { list: undefined }),
  { title: 'Page image', description: 'Rendered PNG of one document page (sheet)', mimeType: 'image/png' },
  async (uri, { doc_id, page }) => {
    const id = kb.resolveDocId(String(doc_id));
    const file = id ? kb.pageImagePath(id, Number(page)) : undefined;
    if (!file) return { contents: [{ uri: uri.href, text: `No image for ${doc_id} page ${page}` }] };
    return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: fs.readFileSync(file).toString('base64') }] };
  },
);

server.registerResource(
  'drive-parameters-raw',
  new ResourceTemplate('waterjet://drives/{axis}', {
    list: async () => ({ resources: kb.drives().map((a) => ({ uri: `waterjet://drives/${a}`, name: `SERVOSTAR parameter dump - axis ${a}`, mimeType: 'text/plain' })) }),
  }),
  { title: 'Drive parameter dump', description: 'Original SERVOSTAR ASCII parameter file of one axis', mimeType: 'text/plain' },
  async (uri, { axis }) => {
    const d = kb.drive(String(axis));
    if (!d) return { contents: [{ uri: uri.href, text: `Unknown axis ${axis}` }] };
    const raw = fs.readFileSync(`${kb.dir}/drives/raw/Amplifier_${d.axis}.txt`, 'utf-8');
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: raw }] };
  },
);

// ---- prompts ----------------------------------------------------------------------------------
server.registerPrompt(
  'troubleshoot',
  { title: 'Troubleshoot a symptom', description: 'Guided troubleshooting of the water jet table or pump from a symptom description', argsSchema: { symptom: z_string('What is happening, e.g. "pump shows FAULT low inlet water pressure" or "Y1 drive error F04"') } },
  ({ symptom }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Symptom on the AMC water jet machine: ${symptom}\n\nUse machine_overview first, then search the documentation (search, get_axis, get_plc_io, get_pump_info alarm_thresholds, find_component) and the relevant schematic sheets (get_page_image) to list: probable causes ranked by likelihood, how to verify each one with the available signals/terminals/display values, and the corrective procedure (get_procedure) with its safety steps. Cite document ids and page numbers.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  'plan-hardware-addition',
  { title: 'Plan a hardware addition', description: 'Plan wiring and integration of a new sensor, actuator or device on the cutting table or pump', argsSchema: { device: z_string('What you want to add, e.g. "a water level float switch in the catcher" or "a pressure transducer on the HP line"') } },
  ({ device }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `I want to add this to the AMC water jet machine: ${device}\n\nUsing get_plc_io (spare), get_axis, find_component, get_procedure adding-io-or-hardware and the sheets (find_sheet / get_page_image), propose: where to connect it (module, terminal strip, fuse, potential numbers), the cable type used elsewhere for the same purpose, what must change in the Cnc886 configuration, and any safety-chain implications. Cite sheet numbers.`,
        },
      },
    ],
  }),
);

function z_string(desc: string) {
  // small helper to avoid importing zod here twice
  return zod.string().describe(desc);
}
import { z as zod } from 'zod';

const transport = new StdioServerTransport();
// exit cleanly when the client disconnects (stdin closed) so no orphan process is left behind
transport.onclose = () => process.exit(0);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
await server.connect(transport);
console.error(`waterjet-mcp ready - knowledge: ${kb.dir} (${kb.catalog.length} documents)`);
