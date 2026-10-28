#!/usr/bin/env python3
"""Build an explicit, secret-free release archive and Homebrew tap formula."""
import argparse
import gzip
import hashlib
import io
import json
import re
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app import VERSION

RELEASE_FILES = (
    'app.py', 'calendar_worklogs.py', 'index.html', 'app.js',
    'calendar.js', 'styles.css', 'mac_calendar.swift', 'mac_calendar-Info.plist',
)
SOURCE_FILES = RELEASE_FILES + (
    '.gitignore', 'README.md', 'packaging/homebrew-tap-README.md',
    'packaging/worklog-studio.rb.in', 'scripts/package_homebrew.py',
)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--source-url', help='Immutable HTTPS release archive URL for the published tap')
    source.add_argument('--github-repo', help='GitHub owner/repo hosting the versioned release asset')
    parser.add_argument('--homepage', help='Project homepage URL for the published tap')
    args = parser.parse_args()
    if args.source_url and not args.source_url.startswith('https://'):
        parser.error('--source-url must be an HTTPS URL')
    if args.homepage and not args.homepage.startswith('https://'):
        parser.error('--homepage must be an HTTPS URL')
    if args.source_url and not args.homepage:
        parser.error('--homepage is required with --source-url')
    if args.github_repo and not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.github_repo):
        parser.error('--github-repo must be OWNER/REPO')

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'worklog-studio-{VERSION}.tar.gz'
    with archive.open('wb') as destination:
        with gzip.GzipFile(filename='', fileobj=destination, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as bundle:
                for name in RELEASE_FILES:
                    content = (ROOT / name).read_bytes()
                    entry = tarfile.TarInfo(f'worklog-studio-{VERSION}/{name}')
                    entry.size = len(content)
                    entry.mode = 0o644
                    entry.mtime = 0
                    bundle.addfile(entry, io.BytesIO(content))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    github_homepage = f'https://github.com/{args.github_repo}' if args.github_repo else None
    source_url = args.source_url or (
        f'{github_homepage}/releases/download/v{VERSION}/{archive.name}' if github_homepage else archive.as_uri()
    )
    homepage = args.homepage or github_homepage or 'https://example.invalid/worklog-studio'
    formula = (ROOT / 'packaging' / 'worklog-studio.rb.in').read_text()
    for marker, value in {'@HOMEPAGE@':homepage, '@ARCHIVE_URL@':source_url,
                          '@VERSION@':VERSION, '@SHA256@':checksum}.items():
        formula = formula.replace(marker, json.dumps(value))
    formula_path = output / 'homebrew-tap' / 'Formula' / 'worklog-studio.rb'
    formula_path.parent.mkdir(parents=True, exist_ok=True)
    formula_path.write_text(formula)
    tap_readme = output / 'homebrew-tap' / 'README.md'
    tap_readme.write_bytes((ROOT / 'packaging' / 'homebrew-tap-README.md').read_bytes())
    source_archive = output / f'worklog-studio-source-v{VERSION}.zip'
    with zipfile.ZipFile(source_archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name in SOURCE_FILES:
            entry = zipfile.ZipInfo(f'worklog-studio/{name}', date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            bundle.writestr(entry, (ROOT / name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    upload_guide = output / 'UPLOAD.txt'
    install_step = (f'4. After the release and tap are public, test: brew install '
                    f'{args.github_repo.split("/")[0]}/tap/worklog-studio\n' if args.github_repo else
                    '4. Regenerate with --github-repo OWNER/REPO before publishing.\n')
    upload_guide.write_text(
        f'1. Extract {source_archive.name}; upload the CONTENTS of worklog-studio/ to {homepage}. '
        'Do not upload the ZIP as a repository file.\n'
        f'2. Create release tag v{VERSION} in that repository and attach {archive.name}.\n'
        f'3. In the separate homebrew-tap repository, upload homebrew-tap/Formula/worklog-studio.rb '
        'to root Formula/ and homebrew-tap/README.md to the repository root.\n'
        + install_step
    )
    print(f'Archive: {archive}')
    print(f'SHA-256: {checksum}')
    print(f'Formula: {formula_path}')
    print(f'Source ZIP: {source_archive}')
    print(f'Upload guide: {upload_guide}')

if __name__ == '__main__':
    main()
