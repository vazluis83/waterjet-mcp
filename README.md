# waterjet-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI assistant the complete
technical documentation of one water jet cutting installation:

| Part | What |
|---|---|
| Cutting table | **PTV WJ3020B 1Z-PJ-NL** ("New Line") gantry table, 3000 x 2000 mm, ProgressJet 5-axis head (axes X1, Y1, Y2, Z1, A1, B1), abrasive feeder, height control |
| Control | AREM PRO **Cnc886** on an Advantech IPC, Windows 10 IoT, CAN bus to drives and I/O |
| Servo drives | 6 x Kollmorgen **SERVOSTAR 600** (443M / 403M / 403A), with the parameter dumps of every axis |
| PLC I/O | Elsaco PROMOS line2 CBIO-12 / CAIO-12 modules |
| High-pressure pump | **PTV JETS 3.8/60-COMPACT**, 37 kW, 4100 bar, 3.8 l/min, H2O Jet 60K intensifier |
| Documentation | 126-sheet electrical documentation, pump manual (82 p.), H2O Jet intensifier service manual (47 p.), drawings (DWG + PDF), spare parts list, service procedures |

The machine is operated by A. Moreira Cadete, Lda. (AMC), Portugal. The server was built so that an assistant can help
with troubleshooting, electrical modifications, adding hardware and maintenance planning while quoting the exact
sheet, page, terminal or part number.

## What the assistant can ask

| Tool | Purpose |
|---|---|
| `machine_overview` | Identity, power supply, safety chain, installed options, where things are documented |
| `search` | Full-text search over every page of every document + curated data (designators, part numbers, signals, words) |
| `get_page`, `get_page_image` | Text and rendered image of any page / schematic sheet |
| `find_sheet`, `get_sheet_index` | Find sheets by subject ("drive Z1", "PLC A2", "terminal XT7", "hydraulic scheme") |
| `get_axis` | Drive, motor, feedback, switches, valves, connectors and sheets of an axis |
| `get_drive_parameters`, `compare_drive_parameters`, `explain_drive_parameter` | SERVOSTAR parameter sets of X, Y1, Y2, Z, A, B with meanings and diffs |
| `get_plc_io` | I/O map of A2 / A3 / A5, the pump handshake signals, spare capacity |
| `find_component` | Any designator or type number -> function, manufacturer part number, location, sheet |
| `search_parts` | H2O Jet / PTV spare parts list (intensifier, check valves, seals, on/off valve, nozzles, filters) |
| `get_pump_info` | Pump specs, distributor elements, hydraulic scheme positions, menus, passwords levels, intervals, alarms, torques |
| `nozzle_flow` | Orifice flow at a pressure and whether the pump can supply it |
| `list_procedures`, `get_procedure` | Step-by-step service procedures (oil change, check valve lapping, seal change, on/off valve kit, portal alignment, control PC, adding I/O ...) |
| `list_drawings`, `get_drawing`, `get_document_images` | CAD drawings (PNG/DXF) and the photos inside the procedure documents |
| `dump_machine_data` | Load a whole curated subject at once |

Resources: `waterjet://docs/{id}` (document text), `waterjet://pages/{id}/{page}` (page PNG), `waterjet://drives/{axis}`
(raw parameter dump). Prompts: `troubleshoot`, `plan-hardware-addition`.

## Install

Requires Node.js 18 or newer.

```bash
git clone https://github.com/<you>/waterjet-mcp.git
cd waterjet-mcp
npm install
npm run build
npm test            # end-to-end smoke test over stdio
```

### Claude Desktop / Claude Code

`claude_desktop_config.json` (or `.mcp.json` in a project for Claude Code):

```json
{
  "mcpServers": {
    "waterjet": {
      "command": "node",
      "args": ["C:/path/to/waterjet-mcp/dist/index.js"]
    }
  }
}
```

Claude Code one-liner:

```bash
claude mcp add waterjet -- node C:/path/to/waterjet-mcp/dist/index.js
```

The knowledge folder is found next to `dist/`; set `WATERJET_KB=/other/path/knowledge` to use another copy.

Try the MCP Inspector: `npm run inspect`.

## Repository layout

```
src/            TypeScript server (index.ts entry, kb.ts loader + search, tools.ts tool definitions)
knowledge/
  catalog.json  document catalogue
  docs/         per-page extracted text of every document (JSON)
  pages/        rendered page images (PNG, 1600 px) and pictures from the Word procedures
  machine/      curated data: overview, axes, plc_io, components, pump, procedures, nozzle_flow, sheets
  drives/       SERVOSTAR parameter dumps (raw + parsed) and the parameter dictionary
  parts/        spare parts price list
  drawings/     DWG conversions (PNG renders, DXF, extracted text) + drawings.json
  source/       the original PDF / DOC / XLS / DWG files
scripts/        build_kb.py (extraction), dwg_convert.mjs (LibreDWG wasm), render_dxf.py (ezdxf)
test/           smoke test
```

## Rebuilding the knowledge base

```bash
pip install pymupdf pillow python-docx xlrd ezdxf matplotlib
npm install                       # also installs @mlightcad/libredwg-web for the DWG conversion
node scripts/dwg_convert.mjs "knowledge/source/Desenhos Tecnicos" /tmp/dwg
python scripts/render_dxf.py /tmp/dwg
python scripts/build_kb.py knowledge/source knowledge --dwg-dir /tmp/dwg
```

The curated files in `knowledge/machine/` and `knowledge/drives/servostar_params.json` were written by hand from the
documents and are not overwritten by the build script.

## Notes and caveats

* **Copyright.** The manuals and drawings belong to PTV spol. s r.o., H2O Jet Inc., Performance Waterjet and 1. Tousenska;
  several drawings carry a confidentiality notice. They are included for the machine owner's own maintenance use. Keep the
  repository private unless you have permission to publish them, or move `knowledge/` elsewhere and point `WATERJET_KB` at it.
* **Pump password.** The level-A service password of the pump panel was deliberately left out of the knowledge base.
* **Drive parameters.** Meanings in the SERVOSTAR dictionary carry a confidence level; those marked medium/low were written
  from memory of the SERVOSTAR 600 ASCII reference and should be checked against the official document before a drive is changed.
* **Safety.** The pump works at 4100 bar and the drives have a 600 V DC bus. Every procedure in the knowledge base starts with
  lock-out and bleed-down; the assistant is instructed to quote them. Nothing here replaces the manufacturer's service.
* The server is read-only: it never talks to the machine.

## License

Code (`src/`, `scripts/`, `test/`) is MIT licensed. The documents under `knowledge/` remain the property of their respective owners.
