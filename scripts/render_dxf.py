#!/usr/bin/env python
"""Render DXF files to PNG with ezdxf + matplotlib.   Usage: python scripts/render_dxf.py <dir-with-dxf>"""
import sys, glob, os
import ezdxf
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

for f in sorted(glob.glob(os.path.join(sys.argv[1], '*.dxf'))):
    try:
        doc = ezdxf.readfile(f); msp = doc.modelspace()
        fig = plt.figure(figsize=(16, 16), dpi=150); ax = fig.add_axes([0, 0, 1, 1]); ax.set_axis_off()
        cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK, lineweight_scaling=0.5)
        Frontend(RenderContext(doc), MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=True)
        fig.savefig(f[:-4] + '.png', dpi=150, bbox_inches='tight', pad_inches=0.2); plt.close(fig)
        print('rendered', os.path.basename(f))
    except Exception as e:
        print('ezdxf failed for', os.path.basename(f), e, '- falling back to the LibreDWG SVG')
        svg = f[:-4] + '.svg'
        if os.path.exists(svg):
            import pymupdf
            d = pymupdf.open(svg); p = d[0]; r = p.rect; z = min(2400 / max(r.width, 1), 2400 / max(r.height, 1), 8)
            p.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False).save(f[:-4] + '.png'); print('rendered (svg)', os.path.basename(f))
