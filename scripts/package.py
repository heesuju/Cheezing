"""Build the Chrome Web Store upload zip: dist/cheezing-<version>.zip

Only files the extension needs at runtime are included (no specs, no git
files). Run from anywhere: python scripts/package.py
"""
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = [
    'manifest.json',
    'background.js',
    'content.js',
    'popup.html',
    'popup.css',
    'popup.js',
    'i18n.js',
    'pdf-store.js',
    'offscreen.html',
    'offscreen.js',
    'icons/icon_16.png',
    'icons/icon_32.png',
    'icons/icon_48.png',
    'icons/icon_128.png',
]
DIRS = ['_locales']

version = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['version']
out = ROOT / 'dist' / f'cheezing-{version}.zip'
out.parent.mkdir(exist_ok=True)

paths = [ROOT / f for f in FILES]
for d in DIRS:
    paths += sorted(p for p in (ROOT / d).rglob('*') if p.is_file())

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for path in paths:
        zf.write(path, path.relative_to(ROOT).as_posix())

print(f'{out.relative_to(ROOT)} ({len(paths)} files, {out.stat().st_size // 1024} KB)')
