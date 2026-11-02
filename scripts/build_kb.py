#!/usr/bin/env python
"""Build the waterjet knowledge base from the original vendor documents.

Usage:  python scripts/build_kb.py <source-dir> <knowledge-dir> [--dwg-dir <dir-with-dxf-svg-png>] [--no-images]

<source-dir> is the folder that holds the original manuals (PDF/DOC/DOCX/XLS),
the "AMC Parameters" folder and the "Desenhos Tecnicos" folder.
The script writes:
  knowledge/catalog.json                 document catalogue (ids, titles, pages)
  knowledge/docs/<id>.json               per-page text of every PDF/DOC/DOCX
  knowledge/pages/<id>/pNNN.png          rendered page images (compact PNG, auto-rotated)
  knowledge/drives/raw/<axis>.txt        original SERVOSTAR parameter dumps
  knowledge/drives/parsed/<axis>.json    parsed parameter sets
  knowledge/parts/catalogue.json         spare parts price list (from the XLS)
  knowledge/drawings/*                   DWG conversions (copied from --dwg-dir)
  knowledge/source/*                     copies of the original files (password file excluded)
Requires: pymupdf, pillow, python-docx, xlrd
"""
import sys, os, re, json, io, zipfile, shutil, pathlib, argparse
import pymupdf
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('source'); ap.add_argument('out'); ap.add_argument('--dwg-dir', default=None)
ap.add_argument('--no-images', action='store_true')
args = ap.parse_args()
SRC = pathlib.Path(args.source); OUT = pathlib.Path(args.out)
for d in ['docs', 'pages', 'drives/raw', 'drives/parsed', 'parts', 'drawings', 'source']:
    (OUT / d).mkdir(parents=True, exist_ok=True)

EXCLUDE_FROM_SOURCE = {'Pump Password.txt'}

# ---- document ids / titles (curated) ---------------------------------------------------------
DOCS = {
    'PTV-052-N-0001 (UD) EN.pdf': dict(id='ptv-electrical', title='PTV WJ3020B 1Z-PJ-NL cutting table - electrical user documentation (PTV-V52-N-0001)', kind='electrical-schematics', language='en/cs', vendor='PTV spol. s r.o.', year=2008, revised='2012-11-06'),
    'MANUAL JETS3.8_60-COMPACT EN(starý-dvojdrážkový píst,mechanický multiplikátor).pdf': dict(id='pump-manual', title='PTV JETS 3.8/60-COMPACT high-pressure pump - operation and maintenance manual (M-01/2007-EN)', kind='manual', language='en', vendor='PTV spol. s r.o.', year=2007, note='File name says: old version - double-groove piston, mechanical-shift intensifier'),
    'Intensifier Manual-Rev C.pdf': dict(id='intensifier-manual', title='H2O Jet intensifier service procedures (IMO-1030 Rev C)', kind='manual', language='en', vendor='H2O Jet Inc.', year=2012),
    'HP Rebuild Installation PWJ onoff.pdf': dict(id='onoff-valve-repair', title='ON/OFF valve repair kit HP (302001-1) installation procedure', kind='procedure', language='en', vendor='Performance Waterjet / H2O Jet'),
    '301002-X CHECK VALVE MACHINING.PDF': dict(id='check-valve-machining', title='Check valve component machining allowances (H2O Jet 301002-X)', kind='drawing', language='en', vendor='H2O Jet Inc.', year=2009),
    'Windows 10 IoT User Guide EN.pdf': dict(id='windows-iot-guide', title='Servicing manual for CNC PCs with Windows 10 IoT Enterprise (Cnc886 control PC)', kind='manual', language='en', vendor='AREM PRO (Cnc886)', year=2024),
    'PTV-012-V-3972 - Dimension CNC table WJ3020-1Z-NL.pdf': dict(id='drawing-table-dimensions', title='Dimension drawing CNC table WJ3020-1Z-NL (PTV-012-V-3972)', kind='drawing', language='cs/en', vendor='PTV', year=2008),
    'PTV-012-V-3762 - Mech portalu X.pdf': dict(id='drawing-bellows-x', title='X portal bellows (Mech portalu X) PTV-012-V-3762', kind='drawing', language='cs', vendor='PTV', year=2008),
    'PTV-012-V-6066 - Drzak  ON-OFF 5AX.pdf': dict(id='drawing-onoff-holder', title='ON/OFF valve holder 5-axis head (Drzak ON-OFF 5AX) PTV-012-V-6066 original', kind='drawing', language='cs', vendor='PTV', year=2009),
    'PTV-012-V-6066a - Drzak  ON-OFF 5AX.pdf': dict(id='drawing-onoff-holder-a', title='ON/OFF valve holder 5-axis head PTV-012-V-6066a (rev a: two M6 holes 34 mm apart)', kind='drawing', language='cs', vendor='PTV', year=2011),
    'PTV-012-V-6066b - Drzak  ON-OFF 5AX.pdf': dict(id='drawing-onoff-holder-b', title='ON/OFF valve holder 5-axis head PTV-012-V-6066b (rev b: M6x12 thread, dia 32 tolerance)', kind='drawing', language='cs', vendor='PTV', year=2011),
    'PTV-012-V-6066c - Drzak  ON-OFF 5AX.pdf': dict(id='drawing-onoff-holder-c', title='ON/OFF valve holder 5-axis head PTV-012-V-6066c (rev c 2014: two M6 holes removed) - current', kind='drawing', language='cs', vendor='PTV', year=2014),
    'C-803-0501-000016-kompl StV1.pdf': dict(id='drawing-abrasive-air-assembly', title='Compressed-air assembly of abrasive hopper TDJ 10T (1. Tousenska C-803-0501-000016)', kind='drawing', language='cs', vendor='1. Tousenska s.r.o.', year=2012),
    'Návod na vyrovnání  zkříženého portálu.docx': dict(id='procedure-portal-alignment', title='Procedure: aligning a twisted (crossed) gantry portal', kind='procedure', language='en/cs', vendor='PTV'),
    'Resetování Check valve.docx': dict(id='procedure-pump-reset-check-valve', title='Procedure: reset the pump check-valve service counter', kind='procedure', language='en/cs', vendor='PTV'),
    'Resetování po výměně oleje ČJ.docx': dict(id='procedure-pump-reset-oil', title='Procedure: reset the pump oil & filter service counter after an oil change', kind='procedure', language='en/cs', vendor='PTV'),
    'výměna těsnění NT.doc': dict(id='procedure-lp-seal-replacement', title='Procedure (pictures): replacement of intensifier low-pressure (hydraulic) seals - vymena tesneni NT', kind='procedure', language='cs', vendor='PTV / Flow pictures'),
    'Firing Pin.txt': dict(id='note-firing-pin', title='Note: firing pin and shift actuator dimensions', kind='note', language='en'),
}
SKIP = {'PTV-012-V-6066a - Drzak  ON-OFF 5AX (1).pdf'}  # duplicate of the 6066a drawing

catalog = []


# Pages whose content is an embedded picture drawn sideways (no text to detect the direction from).
# value = degrees to rotate counter-clockwise (270 = turn the picture 90 degrees clockwise)
FORCE_ROTATION = {'pump-manual': {p: 270 for p in [54, 55, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67]}}


def page_rotation(page, doc_id=None):
    """Return the extra rotation to apply to a rendered page.  PyMuPDF already honours the page /Rotate attribute,
    so only pages without one whose text runs vertically (or pages listed in FORCE_ROTATION) are turned."""
    if doc_id in FORCE_ROTATION and (page.number + 1) in FORCE_ROTATION[doc_id]:
        return FORCE_ROTATION[doc_id][page.number + 1]
    if page.rotation:
        return 0
    try:
        d = page.get_text('dict')
    except Exception:
        return 0
    counts = {'h': 0, 'up': 0, 'down': 0}
    for b in d.get('blocks', []):
        for l in b.get('lines', []):
            dx, dy = l.get('dir', (1, 0)); n = sum(len(s.get('text', '')) for s in l.get('spans', []))
            if abs(dx) > abs(dy): counts['h'] += n
            elif dy < 0: counts['up'] += n
            else: counts['down'] += n
    best = max(counts, key=counts.get)
    if counts[best] == 0 or best == 'h': return 0
    return 270 if best == 'up' else 90


def save_page_png(page, fn, doc_id=None):
    r = page.rect; z = 1600 / max(r.width, r.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False)
    im = Image.open(io.BytesIO(pix.tobytes('png')))
    rot = page_rotation(page, doc_id)
    if rot: im = im.rotate(rot, expand=True)  # PIL rotates counter-clockwise
    if len(page.get_images()) > 3: im.convert('RGB').quantize(64).save(fn, 'PNG', optimize=True)
    else: im.convert('L').quantize(16).save(fn, 'PNG', optimize=True)
    return rot


def write_doc(meta, pages):
    (OUT / 'docs' / f"{meta['id']}.json").write_text(json.dumps(dict(meta, pages=pages), ensure_ascii=False, indent=1), encoding='utf-8')
    catalog.append(meta)


# ---- PDFs -----------------------------------------------------------------------------------
for f in sorted(SRC.glob('*.[pP][dD][fF]')):
    if f.name in SKIP: continue
    if f.name not in DOCS: print('WARN: no catalogue entry for', f.name); continue
    meta = dict(DOCS[f.name]); doc = pymupdf.open(f); pages = []
    pdir = OUT / 'pages' / meta['id']; pdir.mkdir(exist_ok=True)
    for i, page in enumerate(doc):
        entry = dict(page=i + 1, text=page.get_text('text').strip(), images=len(page.get_images()))
        if not args.no_images:
            entry['rotated'] = save_page_png(page, pdir / f'p{i+1:03d}.png', meta['id'])
        pages.append(entry)
    meta.update(source_file=f.name, pages=len(doc), format='pdf', has_page_images=not args.no_images)
    write_doc(meta, pages); print('pdf', meta['id'], len(doc), 'pages')

# ---- DOCX -------------------------------------------------------------------------------------
import docx
for f in sorted(SRC.glob('*.docx')):
    if f.name not in DOCS: print('WARN', f.name); continue
    meta = dict(DOCS[f.name]); d = docx.Document(str(f))
    lines = [p.text for p in d.paragraphs]
    for t in d.tables:
        for r in t.rows:
            cells = []
            for c in r.cells:
                if c.text not in cells: cells.append(c.text)
            lines.append(' | '.join(cells))
    text = '\n'.join(l for l in lines if l.strip())
    pdir = OUT / 'pages' / meta['id']; pdir.mkdir(exist_ok=True); n = 0
    with zipfile.ZipFile(f) as z:
        for zi in z.namelist():
            if zi.startswith('word/media/') and not zi.lower().endswith('.emf'):
                n += 1; data = z.read(zi)
                try:
                    im = Image.open(io.BytesIO(data)).convert('RGB'); im.thumbnail((1600, 1600)); im.save(pdir / f'img{n:02d}.jpg', 'JPEG', quality=80)
                except Exception:
                    (pdir / f'img{n:02d}{os.path.splitext(zi)[1].lower()}').write_bytes(data)
    meta.update(source_file=f.name, pages=1, format='docx', images=n, has_page_images=False)
    write_doc(meta, [dict(page=1, text=text)]); print('docx', meta['id'], n, 'images')

# ---- legacy .DOC (binary): carve embedded pictures, no reliable text -----------------------------
for f in sorted(SRC.glob('*.doc')):
    if f.name not in DOCS: continue
    meta = dict(DOCS[f.name]); b = f.read_bytes(); pdir = OUT / 'pages' / meta['id']; pdir.mkdir(exist_ok=True); n = 0
    blobs = []
    for m in re.finditer(rb'\xff\xd8\xff', b):
        e = b.find(b'\xff\xd9', m.start())
        if e > 0: blobs.append(b[m.start():e + 2])
    for m in re.finditer(rb'\x89PNG\r\n\x1a\n', b):
        e = b.find(b'IEND', m.start())
        if e > 0: blobs.append(b[m.start():e + 8])
    for blob in blobs:
        try:
            im = Image.open(io.BytesIO(blob)); im.load(); im = im.convert('RGB')
            if im.width < 200: continue
            n += 1; im.thumbnail((1400, 1400)); im.save(pdir / f'img{n:02d}.jpg', 'JPEG', quality=80)
        except Exception:
            pass
    text = ('Legacy Word document with pictures only (text could not be extracted). Czech title "vymena tesneni NT" = '
            'replacement of the low-pressure (hydraulic) seals of the intensifier. Pictures show: the hydraulic manifold block, '
            'the hydraulic cylinder bore, driving the end-bell oil seal in with a mallet and installation sleeve, '
            'mounting the end bell / cylinder on the intensifier assembly fixture, pulling the end bells on with the tie rods, '
            'the complete H2O Jet intensifier, and a blue hydraulic cylinder liner. Use get_document_images to view them and '
            'the H2O Jet intensifier manual sections 2.6 (End Bells) and 4 (Piston service) for the written procedure.')
    meta.update(source_file=f.name, pages=1, format='doc', images=n, has_page_images=False)
    write_doc(meta, [dict(page=1, text=text)]); print('doc', meta['id'], n, 'images')

# ---- plain notes ------------------------------------------------------------------------------
for f in sorted(SRC.glob('*.txt')):
    if f.name not in DOCS: continue
    meta = dict(DOCS[f.name]); text = f.read_text(encoding='utf-8', errors='replace').strip()
    meta.update(source_file=f.name, pages=1, format='txt', has_page_images=False)
    write_doc(meta, [dict(page=1, text=text)])

# ---- SERVOSTAR parameter dumps ------------------------------------------------------------------
for f in sorted((SRC / 'AMC Parameters').glob('Amplifier *')):
    axis = f.name.split()[-1]
    raw = f.read_text(encoding='utf-8', errors='replace')
    shutil.copy(f, OUT / 'drives' / 'raw' / f'Amplifier_{axis}.txt')
    header = {}; params = {}; order = []; motion_tasks = []; commented = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line: continue
        if line.startswith(';'):
            body = line[1:].strip(); k, _, v = body.partition(' ')
            if k in ('VER', 'HVER', 'Drive', 'SERIALNO', 'TRUN'): header[k] = v.strip()
            else: commented[k] = v.strip()   # read-only values echoed as comments (ADDR, ANOFF1, DAOFFSET, PASSX, RK ...)
            continue
        k, _, v = line.partition(' ')
        if k == 'ORDER': motion_tasks.append(v.split()); continue
        params[k] = v.strip(); order.append(k)
    parsed = dict(axis=axis, file=f.name, header=header, read_only=commented, parameter_count=len(params),
                  parameters=params, parameter_order=order, motion_tasks=motion_tasks)
    (OUT / 'drives' / 'parsed' / f'{axis}.json').write_text(json.dumps(parsed, ensure_ascii=False, indent=1), encoding='utf-8')
    print('drive', axis, len(params), 'params')

# ---- XLS parts price list --------------------------------------------------------------------
import xlrd
for f in sorted(SRC.glob('*.xls')):
    wb = xlrd.open_workbook(f); sh = wb.sheets()[0]; items = []
    for r in range(2, sh.nrows):
        name = str(sh.cell_value(r, 1)).strip(); order_no = str(sh.cell_value(r, 2)).strip(); note = str(sh.cell_value(r, 5)).strip()
        if not name: continue
        if order_no.endswith('.0'): order_no = order_no[:-2]
        order_no = re.sub(r'\s*[-–]\s*', '-', order_no)
        items.append(dict(name=name, order_no=order_no, note=note))
    (OUT / 'parts' / 'catalogue.json').write_text(json.dumps(dict(source=f.name, title=str(sh.cell_value(0, 1)).strip(), items=items), ensure_ascii=False, indent=1), encoding='utf-8')
    print('parts', len(items))

# ---- DWG conversions ----------------------------------------------------------------------------
if args.dwg_dir:
    for f in pathlib.Path(args.dwg_dir).iterdir():
        if f.suffix.lower() in ('.svg', '.png', '.dxf', '.json'): shutil.copy(f, OUT / 'drawings' / f.name)

# ---- originals ----------------------------------------------------------------------------------
def short_name(name: str) -> str:
    """Shorten/ASCII-fy long original file names so the repository stays usable on Windows (260-char path limit)."""
    import unicodedata
    base, ext = os.path.splitext(name)
    base = re.sub(r'\s*\([^)]*\)\s*', ' ', base).strip()          # drop parenthetical remarks
    base = unicodedata.normalize('NFKD', base).encode('ascii', 'ignore').decode()
    return (base[:60].strip() + ext)

for f in SRC.rglob('*'):
    if f.is_file() and f.name not in EXCLUDE_FROM_SOURCE and f.name not in SKIP:
        rel = f.relative_to(SRC); dest = OUT / 'source' / rel.parent / short_name(rel.name)
        dest.parent.mkdir(parents=True, exist_ok=True); shutil.copy(f, dest)

(OUT / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding='utf-8')
print('catalog', len(catalog), 'documents')
