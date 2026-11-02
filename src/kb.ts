/**
 * Knowledge-base loader for the waterjet MCP server.
 *
 * Everything is read from the `knowledge/` folder (override with the WATERJET_KB environment variable):
 *   catalog.json, docs/<id>.json, pages/<id>/pNNN.png, machine/*.json, drives/*, parts/catalogue.json, drawings/*
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';

export interface DocMeta {
  id: string;
  title: string;
  kind: string;
  language?: string;
  vendor?: string;
  year?: number;
  note?: string;
  source_file: string;
  pages: number;
  format: string;
  images?: number;
  has_page_images: boolean;
}

export interface DocPage {
  page: number;
  text: string;
  images?: number;
  rotated?: number;
}

export interface Doc extends DocMeta {
  pages_content: DocPage[];
}

export interface SearchHit {
  doc_id: string;
  title: string;
  page: number;
  score: number;
  snippet: string;
}

export interface DriveParams {
  axis: string;
  file: string;
  header: Record<string, string>;
  read_only: Record<string, string>;
  parameter_count: number;
  parameters: Record<string, string>;
  parameter_order: string[];
  motion_tasks: string[][];
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function resolveKbDir(): string {
  const candidates = [
    process.env.WATERJET_KB,
    path.resolve(here, '..', 'knowledge'),
    path.resolve(process.cwd(), 'knowledge'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'catalog.json'))) return c;
  }
  throw new Error(`knowledge folder not found (looked in ${candidates.join(', ')}). Set WATERJET_KB.`);
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

export class KnowledgeBase {
  readonly dir: string;
  readonly catalog: DocMeta[];
  private docs = new Map<string, Doc>();
  private machine = new Map<string, unknown>();
  private index: MiniSearch | null = null;
  private indexedPages = new Map<string, { doc_id: string; title: string; page: number; text: string }>();

  constructor(dir = resolveKbDir()) {
    this.dir = dir;
    this.catalog = readJson<DocMeta[]>(path.join(dir, 'catalog.json'));
  }

  // ---- documents ---------------------------------------------------------------------------
  getDoc(id: string): Doc | undefined {
    if (this.docs.has(id)) return this.docs.get(id);
    const p = path.join(this.dir, 'docs', `${id}.json`);
    if (!fs.existsSync(p)) return undefined;
    const raw = readJson<DocMeta & { pages: DocPage[] }>(p);
    const { pages, ...meta } = raw;
    const doc: Doc = { ...(meta as DocMeta), pages: (meta as DocMeta).pages ?? pages.length, pages_content: pages };
    this.docs.set(id, doc);
    return doc;
  }

  resolveDocId(idOrTitle: string): string | undefined {
    const q = idOrTitle.trim().toLowerCase();
    const exact = this.catalog.find((d) => d.id.toLowerCase() === q);
    if (exact) return exact.id;
    const partial = this.catalog.find((d) => d.id.toLowerCase().includes(q) || d.title.toLowerCase().includes(q) || d.source_file.toLowerCase().includes(q));
    return partial?.id;
  }

  getPage(id: string, page: number): DocPage | undefined {
    const doc = this.getDoc(id);
    return doc?.pages_content.find((p) => p.page === page);
  }

  pageImagePath(id: string, page: number): string | undefined {
    const p = path.join(this.dir, 'pages', id, `p${String(page).padStart(3, '0')}.png`);
    return fs.existsSync(p) ? p : undefined;
  }

  documentImages(id: string): string[] {
    const d = path.join(this.dir, 'pages', id);
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .filter((f) => /^img\d+\.(jpg|jpeg|png)$/i.test(f))
      .sort()
      .map((f) => path.join(d, f));
  }

  // ---- curated machine data ------------------------------------------------------------------
  machineData<T = unknown>(name: string): T {
    if (!this.machine.has(name)) {
      const p = path.join(this.dir, 'machine', `${name}.json`);
      this.machine.set(name, fs.existsSync(p) ? readJson(p) : null);
    }
    return this.machine.get(name) as T;
  }

  drives(): string[] {
    const d = path.join(this.dir, 'drives', 'parsed');
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
  }

  drive(axis: string): DriveParams | undefined {
    const name = this.normaliseAxis(axis);
    const p = path.join(this.dir, 'drives', 'parsed', `${name}.json`);
    return fs.existsSync(p) ? readJson<DriveParams>(p) : undefined;
  }

  normaliseAxis(axis: string): string {
    const a = axis.trim().toUpperCase().replace(/^AXIS\s*/, '').replace(/^AMPLIFIER\s*/, '');
    const map: Record<string, string> = { X: 'X', X1: 'X', Y1: 'Y1', Y2: 'Y2', Z: 'Z', Z1: 'Z', A: 'A', A1: 'A', B: 'B', B1: 'B' };
    return map[a] ?? a;
  }

  driveDictionary(): { description: string; parameters: Record<string, { desc: string; unit?: string; confidence: string }>; key_differences_between_axes: Record<string, string> } {
    return readJson(path.join(this.dir, 'drives', 'servostar_params.json'));
  }

  parts(): { source: string; title: string; items: { name: string; order_no: string; note: string }[] } {
    return readJson(path.join(this.dir, 'parts', 'catalogue.json'));
  }

  drawings(): { description: string; drawings: Record<string, string>[]; pdf_drawings: Record<string, unknown>[] } {
    return readJson(path.join(this.dir, 'drawings', 'drawings.json'));
  }

  drawingFile(name: string): string | undefined {
    const p = path.join(this.dir, 'drawings', name);
    return fs.existsSync(p) ? p : undefined;
  }

  // ---- full-text search ----------------------------------------------------------------------
  private buildIndex(): MiniSearch {
    const ms = new MiniSearch({
      fields: ['text', 'title'],
      storeFields: ['doc_id', 'title', 'page'],
      searchOptions: { boost: { title: 2 }, prefix: (term) => term.length >= 4, fuzzy: (term) => (term.length >= 6 ? 0.15 : false), combineWith: 'AND' },
      tokenize: (s) => s.toLowerCase().split(/[^\p{L}\p{N}.+\-/_]+/u).filter((t) => t.length > 1),
      processTerm: (t) => t.replace(/^[.\-/_]+|[.\-/_]+$/g, '') || null,
    });
    const entries: { id: string; doc_id: string; title: string; page: number; text: string }[] = [];
    for (const meta of this.catalog) {
      const doc = this.getDoc(meta.id);
      if (!doc) continue;
      for (const p of doc.pages_content) {
        if (!p.text || p.text.length < 5) continue;
        entries.push({ id: `${meta.id}#${p.page}`, doc_id: meta.id, title: `${meta.title} - page ${p.page}`, page: p.page, text: p.text });
      }
    }
    // curated machine data as pseudo documents (page 0)
    const machineDir = path.join(this.dir, 'machine');
    if (fs.existsSync(machineDir)) {
      for (const f of fs.readdirSync(machineDir).filter((f) => f.endsWith('.json'))) {
        const name = f.replace(/\.json$/, '');
        const text = flatten(readJson(path.join(machineDir, f)));
        entries.push({ id: `machine:${name}#0`, doc_id: `machine:${name}`, title: `Curated machine data: ${name}`, page: 0, text });
      }
    }
    const parts = path.join(this.dir, 'parts', 'catalogue.json');
    if (fs.existsSync(parts)) entries.push({ id: 'parts#0', doc_id: 'parts', title: 'Spare parts catalogue', page: 0, text: flatten(readJson(parts)) });
    const dict = path.join(this.dir, 'drives', 'servostar_params.json');
    if (fs.existsSync(dict)) entries.push({ id: 'drives:dictionary#0', doc_id: 'drives:dictionary', title: 'SERVOSTAR parameter dictionary', page: 0, text: flatten(readJson(dict)) });
    for (const e of entries) this.indexedPages.set(e.id, e);
    ms.addAll(entries);
    return ms;
  }

  search(query: string, limit = 10, docId?: string): SearchHit[] {
    if (!this.index) this.index = this.buildIndex();
    let results = this.index.search(query);
    if (results.length === 0) results = this.index.search(query, { combineWith: 'OR' });
    const hits: SearchHit[] = [];
    for (const r of results) {
      if (docId && r.doc_id !== docId) continue;
      const entry = this.indexedPages.get(String(r.id));
      if (!entry) continue;
      hits.push({ doc_id: r.doc_id, title: r.title, page: r.page, score: Math.round(r.score * 100) / 100, snippet: snippet(entry.text, query) });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

/** Flatten nested JSON into a searchable text blob ("key: value" lines). */
export function flatten(v: unknown, prefix = ''): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return `${prefix}${String(v)}\n`;
  if (Array.isArray(v)) return v.map((x) => flatten(x, prefix)).join('');
  return Object.entries(v as Record<string, unknown>)
    .map(([k, val]) => (typeof val === 'object' && val !== null ? `${k}:\n${flatten(val, prefix + '  ')}` : `${prefix}${k}: ${String(val)}\n`))
    .join('');
}

/** Build a short snippet around the first query term found in the text. */
export function snippet(text: string, query: string, width = 260): string {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    pos = lower.indexOf(t.replace(/[*]/g, ''));
    if (pos >= 0) break;
  }
  if (pos < 0) pos = 0;
  const start = Math.max(0, pos - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  const s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + (end < text.length ? '…' : '');
}
