"""Resize and convert the sky-island source textures to WebP.

Usage: python textures.py <assets-src> <out-dir>

Only textures referenced by the curated models (see manifest.json) are
converted. Sizes are chosen for how large each material appears on screen;
normal and ORM maps of small props are dropped by the glTF build instead.
"""
import json
import sys
from pathlib import Path

from PIL import Image

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
MANIFEST = json.loads((Path(__file__).parent / "manifest.json").read_text(encoding="utf-8"))

written = []
for entry in MANIFEST["textures"]:
    source = SRC / entry["source"]
    image = Image.open(source)
    keep_alpha = entry.get("alpha", False)
    image = image.convert("RGBA" if keep_alpha else "RGB")
    size = entry["size"]
    if max(image.size) > size:
        image = image.resize((size, round(size * image.size[1] / image.size[0])), Image.LANCZOS)
    target = OUT / (Path(entry["source"]).stem + ".webp")
    # Colour maps tolerate lossy compression well; alpha-tested leaves keep a
    # lossless alpha channel so cut-out edges stay crisp.
    image.save(target, "WEBP", quality=entry.get("quality", 86), method=6, lossless=False, exact=keep_alpha)
    written.append((target.name, image.size, target.stat().st_size))

total = sum(size for _, _, size in written)
for name, dimensions, size in written:
    print(f"{name:42} {dimensions[0]:>5}x{dimensions[1]:<5} {size / 1024:8.1f} KiB")
print(f"total {total / 1024 / 1024:.2f} MiB in {len(written)} textures")
