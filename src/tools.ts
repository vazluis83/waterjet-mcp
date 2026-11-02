/**
 * Tool definitions of the waterjet MCP server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KnowledgeBase, flatten } from './kb.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const text = (t: string): { content: Content[] } => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown): { content: Content[] } => text(JSON.stringify(v, null, 2));
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

function imageContent(file: string): Content {
  const data = fs.readFileSync(file).toString('base64');
  const mimeType = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { type: 'image', data, mimeType };
}

export function registerTools(server: McpServer, kb: KnowledgeBase): void {
  // ---------------------------------------------------------------- overview / catalogue
  server.registerTool(
    'machine_overview',
    {
      title: 'Machine overview',
      description:
        'Identity and key facts of the water jet installation: PTV WJ3020B 1Z-PJ-NL cutting table (Cnc886 control, Kollmorgen SERVOSTAR drives, Elsaco PLC I/O), JETS 3.8/60-COMPACT pump, power supply, safety chain, options installed and where to find each subject in the documents. Call this first.',
      inputSchema: {},
    },
    async () => json(kb.machineData('overview')),
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: 'List all documents in the knowledge base (manuals, electrical schematics, drawings, procedures, notes) with their ids, titles, vendor, language and page counts.',
      inputSchema: {},
    },
    async () => json(kb.catalog.map(({ id, title, kind, language, vendor, year, pages, format, source_file }) => ({ id, title, kind, language, vendor, year, pages, format, source_file }))),
  );

  // ---------------------------------------------------------------- search & reading
  server.registerTool(
    'search',
    {
      title: 'Full-text search',
      description:
        'Search every page of every document plus the curated machine data (axes, PLC I/O, components, pump, procedures, parts, drive parameter dictionary). Returns ranked hits with document id, page number and a snippet. Use device designators (e.g. "KM1", "SQ14", "XT7"), part numbers ("302001-1"), signal names ("PSTOP", "COM_OUT3"), or plain words. Follow up with get_page / get_page_image to read the full sheet.',
      inputSchema: {
        query: z.string().describe('Search terms (AND by default, falls back to OR). Prefix matching and light fuzzy matching are on.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of hits'),
        doc_id: z.string().optional().describe('Restrict to one document id (see list_documents), e.g. "ptv-electrical" or "pump-manual"'),
      },
    },
    async ({ query, limit, doc_id }) => {
      const id = doc_id ? kb.resolveDocId(doc_id) ?? doc_id : undefined;
      const hits = kb.search(query, limit, id);
      if (hits.length === 0) return text(`No hits for "${query}"${id ? ` in ${id}` : ''}.`);
      return json(hits);
    },
  );

  server.registerTool(
    'get_page',
    {
      title: 'Get page text',
      description:
        'Return the extracted text of one page of a document (and optionally the rendered page image). For schematic sheets the text is a list of labels, designators and wire numbers; request the image to read the actual circuit. Page numbers are PDF page numbers (= sheet numbers for the electrical documentation).',
      inputSchema: {
        doc_id: z.string().describe('Document id or part of its title/file name'),
        page: z.number().int().min(1).describe('Page number'),
        include_image: z.boolean().default(false).describe('Also return the rendered page as an image'),
      },
    },
    async ({ doc_id, page, include_image }) => {
      const id = kb.resolveDocId(doc_id);
      if (!id) return fail(`Unknown document "${doc_id}". Use list_documents.`);
      const p = kb.getPage(id, page);
      if (!p) return fail(`Document ${id} has no page ${page}.`);
      const content: Content[] = [{ type: 'text', text: `# ${id} page ${page}\n\n${p.text || '(no extractable text - this page is a picture; use the image)'}` }];
      if (include_image) {
        const img = kb.pageImagePath(id, page);
        if (img) content.push(imageContent(img));
      }
      return { content };
    },
  );

  server.registerTool(
    'get_page_image',
    {
      title: 'Get page image',
      description: 'Return the rendered image (PNG, 1600 px long side) of a document page, e.g. a wiring sheet of the electrical documentation, the hydraulic scheme of the pump, or a drawing. Use search or find_sheet to find the page number first.',
      inputSchema: {
        doc_id: z.string().describe('Document id'),
        page: z.number().int().min(1).describe('Page number'),
      },
    },
    async ({ doc_id, page }) => {
      const id = kb.resolveDocId(doc_id);
      if (!id) return fail(`Unknown document "${doc_id}".`);
      const img = kb.pageImagePath(id, page);
      if (!img) return fail(`No page image for ${id} page ${page}.`);
      const p = kb.getPage(id, page);
      return { content: [{ type: 'text', text: `${id} page ${page}${p?.rotated ? ' (auto-rotated to landscape)' : ''}` }, imageContent(img)] };
    },
  );

  server.registerTool(
    'get_document_images',
    {
      title: 'Get document images',
      description: 'Return the pictures embedded in a Word procedure document (portal alignment photos, pump display screenshots, intensifier seal replacement photos).',
      inputSchema: { doc_id: z.string().describe('Document id, e.g. procedure-portal-alignment'), max_images: z.number().int().min(1).max(20).default(8) },
    },
    async ({ doc_id, max_images }) => {
      const id = kb.resolveDocId(doc_id);
      if (!id) return fail(`Unknown document "${doc_id}".`);
      const files = kb.documentImages(id).slice(0, max_images);
      if (files.length === 0) return text(`Document ${id} has no embedded images (use get_page_image for PDF pages).`);
      const content: Content[] = [{ type: 'text', text: `${files.length} image(s) from ${id}` }];
      for (const f of files) content.push({ type: 'text', text: path.basename(f) }, imageContent(f));
      return { content };
    },
  );

  server.registerTool(
    'find_sheet',
    {
      title: 'Find schematic sheet',
      description: 'Find sheets (pages) of the electrical documentation or the pump manual by subject, e.g. "drive Z1", "PLC A2", "terminal XT7", "hydraulic scheme", "operator panel". Returns page numbers to use with get_page_image.',
      inputSchema: { query: z.string().describe('Words from the sheet title'), doc_id: z.enum(['ptv-electrical', 'pump-manual', 'any']).default('any') },
    },
    async ({ query, doc_id }) => {
      const sheets = kb.machineData<Record<string, { description: string; sheets: { page: number; title: string }[] }>>('sheets');
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const out: { doc_id: string; page: number; title: string; matched: number }[] = [];
      for (const [d, v] of Object.entries(sheets)) {
        if (doc_id !== 'any' && d !== doc_id) continue;
        for (const s of v.sheets) {
          const t = s.title.toLowerCase();
          const tokens = t.split(/[^a-z0-9.]+/);
          // whole-token match (e.g. "xt7" in "Table XT7") counts double, substring match single
          const matched = terms.reduce((n, w) => n + (tokens.includes(w) ? 2 : t.includes(w) ? 1 : 0), 0);
          if (matched > 0) out.push({ doc_id: d, page: s.page, title: s.title, matched });
        }
      }
      out.sort((a, b) => b.matched - a.matched || a.page - b.page);
      return out.length ? json(out.slice(0, 25)) : text(`No sheet title matches "${query}". Try the search tool.`);
    },
  );

  server.registerTool(
    'get_sheet_index',
    {
      title: 'Sheet index',
      description: 'Complete page/sheet index of the electrical documentation (126 sheets) and the pump manual (82 pages) with one-line titles.',
      inputSchema: { doc_id: z.enum(['ptv-electrical', 'pump-manual', 'all']).default('all') },
    },
    async ({ doc_id }) => {
      const sheets = kb.machineData<Record<string, unknown>>('sheets');
      return json(doc_id === 'all' ? sheets : sheets[doc_id]);
    },
  );

  // ---------------------------------------------------------------- axes & drives
  server.registerTool(
    'get_axis',
    {
      title: 'Axis details',
      description:
        'Everything about one axis of the cutting table: drive model and CAN address, motor, feedback, limit/reference switches, valves and sensors on that trolley, connectors, terminal strips and the schematic sheets. Axes: X1, Y1, Y2, Z1, A1, B1, abrasive feeder. Without an argument returns all axes plus general notes.',
      inputSchema: { axis: z.string().optional().describe('X1 | Y1 | Y2 | Z1 | A1 | B1 | abrasive (optional)') },
    },
    async ({ axis }) => {
      const data = kb.machineData<{ notes: string[]; axes: { axis: string }[]; unused_in_this_configuration: string[] }>('axes');
      if (!axis) return json(data);
      const q = axis.trim().toUpperCase();
      const hit = data.axes.find((a) => a.axis.toUpperCase() === q || a.axis.toUpperCase().startsWith(q) || (q.startsWith('ABR') && a.axis.toLowerCase().includes('abrasive')));
      if (!hit) return fail(`Unknown axis "${axis}". Known: ${data.axes.map((a) => a.axis).join(', ')}`);
      const drive = kb.drive(axis);
      const summary = drive
        ? { parameter_file: drive.file, header: drive.header, can_address: drive.read_only?.ADDR, key_parameters: pick(drive.parameters, ['OPMODE', 'MNAME', 'FBTYPE', 'MPOLES', 'MSPEED', 'VLIM', 'ICONT', 'IPEAK', 'MICONT', 'MIPEAK', 'GP', 'GV', 'GVTN', 'KC', 'KTN', 'DIR', 'MBRAKE', 'PBALRES', 'IN1MODE', 'IN2MODE', 'IN3MODE', 'IN4MODE', 'O1MODE', 'O2MODE', 'ENCLINES', 'GEARMODE', 'GEARI', 'GEARO', 'PGEARI', 'PGEARO', 'PVMAX', 'ACC', 'DEC', 'DECSTOP', 'DECDIS', 'PEMAX', 'PEINPOS', 'CBAUD']) }
        : undefined;
      return json({ ...hit, drive_parameter_summary: summary, notes: data.notes });
    },
  );

  server.registerTool(
    'get_drive_parameters',
    {
      title: 'SERVOSTAR drive parameters',
      description:
        'Return the Kollmorgen SERVOSTAR parameter set dumped from one axis drive (files "Amplifier X/Y1/Y2/Z/A/B" kept by AMC). Optionally filter by parameter names or a substring. Each value is annotated with its meaning from the parameter dictionary when known.',
      inputSchema: {
        axis: z.string().describe('X | Y1 | Y2 | Z | A | B (also accepts X1, Z1, A1, B1)'),
        names: z.array(z.string()).optional().describe('Exact parameter names to return, e.g. ["GP","GV","GVTN"]'),
        filter: z.string().optional().describe('Case-insensitive substring to match parameter names, e.g. "IN" or "GEAR"'),
        raw: z.boolean().default(false).describe('Return the original dump text instead of JSON'),
      },
    },
    async ({ axis, names, filter, raw }) => {
      const d = kb.drive(axis);
      if (!d) return fail(`No parameter file for axis "${axis}". Available: ${kb.drives().join(', ')}`);
      if (raw) {
        const p = path.join(kb.dir, 'drives', 'raw', `Amplifier_${d.axis}.txt`);
        return text(fs.readFileSync(p, 'utf-8'));
      }
      const dict = kb.driveDictionary().parameters;
      const wanted = new Set((names ?? []).map((n) => n.toUpperCase()));
      const f = filter?.toUpperCase();
      const params: Record<string, { value: string; meaning?: string }> = {};
      for (const k of d.parameter_order) {
        if (wanted.size && !wanted.has(k)) continue;
        if (f && !k.includes(f)) continue;
        params[k] = { value: d.parameters[k], meaning: lookupParam(dict, k)?.desc };
      }
      return json({ axis: d.axis, file: d.file, header: d.header, read_only: d.read_only, count: Object.keys(params).length, parameters: params, motion_tasks: wanted.size || f ? undefined : d.motion_tasks });
    },
  );

  server.registerTool(
    'compare_drive_parameters',
    {
      title: 'Compare two drives',
      description: 'Diff the parameter sets of two axis drives and explain each differing parameter. Useful when cloning a drive, replacing a SERVOSTAR, or checking why two axes behave differently.',
      inputSchema: { axis_a: z.string().describe('First axis (X, Y1, Y2, Z, A, B)'), axis_b: z.string().describe('Second axis') },
    },
    async ({ axis_a, axis_b }) => {
      const a = kb.drive(axis_a);
      const b = kb.drive(axis_b);
      if (!a || !b) return fail(`Unknown axis. Available: ${kb.drives().join(', ')}`);
      const dict = kb.driveDictionary().parameters;
      const keys = new Set([...a.parameter_order, ...b.parameter_order]);
      const diffs: { parameter: string; [k: string]: string | undefined }[] = [];
      for (const k of keys) {
        if (a.parameters[k] !== b.parameters[k]) diffs.push({ parameter: k, [a.axis]: a.parameters[k], [b.axis]: b.parameters[k], meaning: lookupParam(dict, k)?.desc });
      }
      return json({ axis_a: { axis: a.axis, header: a.header, addr: a.read_only?.ADDR }, axis_b: { axis: b.axis, header: b.header, addr: b.read_only?.ADDR }, differing_parameters: diffs.length, differences: diffs, identical_motion_tasks: JSON.stringify(a.motion_tasks) === JSON.stringify(b.motion_tasks) });
    },
  );

  server.registerTool(
    'explain_drive_parameter',
    {
      title: 'Explain drive parameter',
      description: 'Explain a SERVOSTAR 600 ASCII parameter (e.g. GP, GVTN, FBTYPE, IN3MODE, PGEARI) and show its value in every axis drive. Entries carry a confidence level; verify medium/low ones in the Kollmorgen ASCII reference before changing a drive.',
      inputSchema: { name: z.string().describe('Parameter name') },
    },
    async ({ name }) => {
      const dict = kb.driveDictionary();
      const key = name.trim().toUpperCase();
      const entry = lookupParam(dict.parameters, key);
      const values: Record<string, string | undefined> = {};
      for (const ax of kb.drives()) {
        const d = kb.drive(ax);
        values[ax] = d?.parameters[key] ?? d?.read_only?.[key] ?? d?.header?.[key];
      }
      return json({ parameter: key, ...(entry ?? { desc: 'Not in the local dictionary - consult the SERVOSTAR 600 ASCII command reference.', confidence: 'none' }), values_per_axis: values, axis_differences: dict.key_differences_between_axes });
    },
  );

  // ---------------------------------------------------------------- PLC, components, parts
  server.registerTool(
    'get_plc_io',
    {
      title: 'PLC I/O map',
      description: 'I/O assignment of the Elsaco PROMOS line2 modules (A2 CBIO-12, A3 CAIO-12, A5 CBIO-12) on CAN bus 2, the relay interface to the high-pressure pump (COM_IN/COM_OUT), and notes on spare capacity for adding hardware.',
      inputSchema: { module: z.enum(['A2', 'A3', 'A5', 'pump_interface', 'spare', 'all']).default('all') },
    },
    async ({ module }) => {
      const d = kb.machineData<{ description: string; modules: { designator: string }[]; pump_io_interface: unknown; spare_capacity_for_additions: unknown }>('plc_io');
      if (module === 'all') return json(d);
      if (module === 'pump_interface') return json(d.pump_io_interface);
      if (module === 'spare') return json({ spare_capacity_for_additions: d.spare_capacity_for_additions });
      return json(d.modules.find((m) => m.designator === `-${module}`));
    },
  );

  server.registerTool(
    'find_component',
    {
      title: 'Find electrical component',
      description:
        'Look up an electrical component of the cutting table by designator (KM1, FU3, SQ14, YV11, XT7, GF1.5 ...), type (LC1D18BD, XPS-AC5121), manufacturer or function words (contactor, limit switch, valve, fuse). Returns function, type, manufacturer part number, location and the sheet where it is drawn. Also searches cables.',
      inputSchema: { query: z.string().describe('Designator, type number or keyword'), limit: z.number().int().min(1).max(50).default(15) },
    },
    async ({ query, limit }) => {
      const d = kb.machineData<{ components: Record<string, string>[]; cables: Record<string, string>[] }>('components');
      const q = query.trim().toLowerCase().replace(/^-/, '');
      const score = (c: Record<string, string>) => {
        const ref = (c.ref ?? '').toLowerCase().replace(/-/g, ' ');
        const blob = Object.values(c).join(' ').toLowerCase();
        if (ref.split(/[\s/,]+/).includes(q)) return 3;
        if (ref.includes(q)) return 2;
        if (blob.includes(q)) return 1;
        return 0;
      };
      const all = [...d.components.map((c) => ({ ...c, _kind: 'component' })), ...d.cables.map((c) => ({ ...c, _kind: 'cable' }))];
      const hits = all.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.c);
      const pages = kb.search(query, 5, 'ptv-electrical');
      return json({ matches: hits, schematic_pages_mentioning_it: pages.map((h) => ({ page: h.page, snippet: h.snippet })) });
    },
  );

  server.registerTool(
    'search_parts',
    {
      title: 'Search spare parts',
      description: 'Search the H2O Jet / PTV spare parts price list used by AMC (intensifier, check valves, seals, on/off valve, nozzles, mixing tubes, filters, lubricants, swivels) by name or order number, and the spare-parts pages of the pump manual.',
      inputSchema: { query: z.string().describe('Part name or order number, e.g. "check valve", "302003", "orifice"'), limit: z.number().int().min(1).max(60).default(20) },
    },
    async ({ query, limit }) => {
      const parts = kb.parts();
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const items = parts.items
        .map((it) => ({ it, s: terms.filter((t) => `${it.name} ${it.order_no} ${it.note}`.toLowerCase().includes(t)).length }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => x.it);
      const manualHits = kb.search(query, 5, 'pump-manual').filter((h) => h.page >= 69);
      return json({ source: parts.title, items, pump_manual_catalogue_pages: manualHits.map((h) => ({ page: h.page, snippet: h.snippet })) });
    },
  );

  // ---------------------------------------------------------------- pump
  server.registerTool(
    'get_pump_info',
    {
      title: 'High-pressure pump info',
      description: 'Structured data on the JETS 3.8/60-COMPACT pump: technical parameters, electrical installation and distributor elements, hydraulic scheme positions, display abbreviations, password levels and menus, service intervals, alarm thresholds, torques, lubricants.',
      inputSchema: {
        section: z.enum(['all', 'technical_parameters_60K', 'technical_parameters_40K', 'electrical_installation', 'hydraulic_scheme_PTV-011-D-0173_positions', 'display_abbreviations', 'password_levels', 'service_intervals', 'alarm_thresholds', 'torques', 'lubricants']).default('all'),
      },
    },
    async ({ section }) => {
      const d = kb.machineData<Record<string, unknown>>('pump');
      return json(section === 'all' ? d : { model: d.model, [section]: d[section] });
    },
  );

  server.registerTool(
    'nozzle_flow',
    {
      title: 'Orifice flow / pump capacity',
      description:
        'Water flow through a pure-water orifice from the pump manual table (orifice diameter in thousandths of an inch, pressure in psi or bar) and whether the JETS 3.8/60 pump (3.8 l/min) can supply it. Give several orifices to check a multi-head or orifice + leak scenario. Also returns the pump pressure-level table.',
      inputSchema: {
        orifice_thou: z.array(z.number()).min(1).describe('Orifice diameters in 0.001 inch (3-17), e.g. [10] or [12, 12]'),
        pressure_psi: z.number().optional().describe('Pressure in psi (20000-60000)'),
        pressure_bar: z.number().optional().describe('Pressure in bar (alternative to psi)'),
      },
    },
    async ({ orifice_thou, pressure_psi, pressure_bar }) => {
      const d = kb.machineData<{ pressures_psi: number[]; flow_l_min_by_orifice_thou: Record<string, number[]>; pressure_levels_pump_panel: unknown; pump_limits: unknown }>('nozzle_flow');
      const psi = pressure_psi ?? (pressure_bar ? pressure_bar * 14.5038 : 60000);
      const ps = d.pressures_psi;
      const interp = (row: number[]) => {
        if (psi <= ps[0]) return row[0];
        if (psi >= ps[ps.length - 1]) return row[row.length - 1];
        for (let i = 0; i < ps.length - 1; i++) if (psi >= ps[i] && psi <= ps[i + 1]) return row[i] + ((row[i + 1] - row[i]) * (psi - ps[i])) / (ps[i + 1] - ps[i]);
        return row[row.length - 1];
      };
      const results = orifice_thou.map((o) => {
        const key = String(Math.round(o));
        const row = d.flow_l_min_by_orifice_thou[key];
        if (!row) return { orifice_thou: o, error: 'outside table (3-17 thou)' };
        return { orifice_thou: o, orifice_mm: Math.round(o * 0.0254 * 1000) / 1000, flow_l_min: Math.round(interp(row) * 100) / 100 };
      });
      const total = results.reduce((s, r) => s + ('flow_l_min' in r ? r.flow_l_min ?? 0 : 0), 0);
      return json({
        pressure_psi: Math.round(psi),
        pressure_bar: Math.round(psi / 14.5038),
        orifices: results,
        total_flow_l_min: Math.round(total * 100) / 100,
        pump_capacity_l_min: 3.8,
        within_pump_capacity: total <= 3.8,
        utilisation_percent: Math.round((total / 3.8) * 100),
        note: 'Above ~90 % utilisation the intensifier approaches its 110 cycles/min limit; a worn orifice flows more than nominal.',
        pump_limits: d.pump_limits,
        pressure_levels: d.pressure_levels_pump_panel,
      });
    },
  );

  // ---------------------------------------------------------------- procedures
  server.registerTool(
    'list_procedures',
    { title: 'List procedures', description: 'List the maintenance and service procedures available (pump start/stop, oil change, service counter reset, check valve lapping, HP seal change, LP seals/end bells, bleed-down valve, ON/OFF valve repair kit, firing pin, portal alignment, control PC maintenance, adding hardware/I-O).', inputSchema: {} },
    async () => json(kb.machineData<{ procedures: { id: string; title: string; source: string }[] }>('procedures').procedures.map(({ id, title, source }) => ({ id, title, source }))),
  );

  server.registerTool(
    'get_procedure',
    {
      title: 'Get procedure',
      description: 'Return a step-by-step maintenance procedure with torques, part numbers and the source pages. Use list_procedures for the ids; a free-text name also works.',
      inputSchema: { id: z.string().describe('Procedure id or words from its title') },
    },
    async ({ id }) => {
      const procs = kb.machineData<{ procedures: { id: string; title: string }[] }>('procedures').procedures;
      const q = id.toLowerCase().trim();
      const words = q.split(/[\s\-_]+/).filter(Boolean);
      const stem = (w: string) => w.slice(0, Math.max(4, w.length - 3));
      const hit =
        procs.find((p) => p.id === q || p.id === words.join('-')) ??
        procs.find((p) => p.id.includes(q) || p.title.toLowerCase().includes(q)) ??
        procs.find((p) => words.every((w) => `${p.id} ${p.title}`.toLowerCase().includes(stem(w))));
      if (!hit) return fail(`No procedure "${id}". Available: ${procs.map((p) => p.id).join(', ')}`);
      return json(hit);
    },
  );

  // ---------------------------------------------------------------- drawings
  server.registerTool(
    'list_drawings',
    { title: 'List drawings', description: 'List the CAD drawings (converted from DWG: table general arrangement, workshop layout, cutting head, height sensor arm, X bellows) and the PDF drawings (table dimensions, ON/OFF valve holder, abrasive hopper air assembly, check valve machining) with key dimensions.', inputSchema: {} },
    async () => json(kb.drawings()),
  );

  server.registerTool(
    'get_drawing',
    {
      title: 'Get drawing',
      description: 'Return a CAD drawing as an image (PNG render of the DWG) together with its metadata and extracted text; DXF/SVG file paths are reported for CAD use. For PDF drawings use get_page_image with the document id.',
      inputSchema: { id: z.string().describe('Drawing id from list_drawings (e.g. cutting-head, height-sensor-arm, bellows-x, ptv-waterjet-table, waterjet-plant-layout)') },
    },
    async ({ id }) => {
      const d = kb.drawings();
      const q = id.toLowerCase();
      const hit = d.drawings.find((x) => x.id === q) ?? d.drawings.find((x) => x.id.includes(q) || x.title.toLowerCase().includes(q));
      if (!hit) return fail(`Unknown drawing "${id}". Available: ${d.drawings.map((x) => x.id).join(', ')}`);
      const content: Content[] = [];
      const metaFile = kb.drawingFile(hit.png.replace(/\.png$/, '.json'));
      const meta = metaFile ? JSON.parse(fs.readFileSync(metaFile, 'utf-8')) : undefined;
      content.push({ type: 'text', text: JSON.stringify({ ...hit, dxf_path: kb.drawingFile(hit.dxf), svg_path: hit.svg ? kb.drawingFile(hit.svg) : undefined, cad_metadata: meta }, null, 2) });
      const png = kb.drawingFile(hit.png);
      if (png) content.push(imageContent(png));
      return { content };
    },
  );

  // ---------------------------------------------------------------- everything at once (for small context models)
  server.registerTool(
    'dump_machine_data',
    {
      title: 'Dump curated data',
      description: 'Return one curated data file as text: overview, axes, plc_io, components, pump, procedures, nozzle_flow, sheets. Handy to load a whole subject into context at once.',
      inputSchema: { name: z.enum(['overview', 'axes', 'plc_io', 'components', 'pump', 'procedures', 'nozzle_flow', 'sheets']) },
    },
    async ({ name }) => text(flatten(kb.machineData(name))),
  );
}

function pick(obj: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/** Dictionary keys may be grouped ("IN1MODE .. IN4MODE", "GPFBT / GPFFT / GPFFV", "P1 .. P16"). */
function lookupParam(dict: Record<string, { desc: string; unit?: string; confidence: string }>, name: string) {
  if (dict[name]) return dict[name];
  for (const [k, v] of Object.entries(dict)) {
    const parts = k.split(/\s*\/\s*/);
    if (parts.includes(name)) return v;
    const range = k.match(/^([A-Z]+)(\d+)\s*\.\.\s*(?:[A-Z]*)(\d+)(N?)$/);
    if (range) {
      const m = name.match(/^([A-Z]+)(\d+)(N?)$/);
      if (m && m[1] === range[1] && Number(m[2]) >= Number(range[2]) && Number(m[2]) <= Number(range[3])) return v;
    }
    if (k.includes('..')) {
      const [a, b] = k.split('..').map((s) => s.trim());
      const pa = a.match(/^([A-Z]+?)(\d+)$/);
      const pb = b.match(/^([A-Z]+?)(\d+)$/);
      const m = name.match(/^([A-Z]+?)(\d+)$/);
      if (pa && pb && m && m[1] === pa[1] && Number(m[2]) >= Number(pa[2]) && Number(m[2]) <= Number(pb[2])) return v;
    }
  }
  return undefined;
}
