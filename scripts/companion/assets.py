"""Pinned local asset validation. Importing this module performs no IO or downloads."""
import hashlib
import json
import stat
import zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
APP_ROOT = HERE.parents[1]


def pins():
    return json.loads((HERE / 'assets.lock.json').read_text(encoding='utf-8'))


def inside(path, root):
    resolved, parent = Path(path).resolve(), Path(root).resolve()
    if not resolved.is_relative_to(parent) or resolved == parent:
        raise RuntimeError('Path must remain inside the explicitly owned runtime directory.')
    return resolved


def runtime_root(value=None, app_root=APP_ROOT):
    return inside(value or Path(app_root) / '.runtime' / 'companion', Path(app_root) / '.runtime')


def digest_file(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def verify_file(path, pin):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != pin['bytes'] or digest_file(path) != pin['sha256']:
        raise RuntimeError('A local asset does not match its pinned byte count and SHA256.')


def archive_entries(archive, prefix):
    entries, seen, expanded = [], set(), 0
    for entry in archive.infolist():
        name = entry.filename.replace('\\', '/')
        if not name.startswith(prefix):
            raise RuntimeError('Archive root differs from its pinned package layout.')
        name = name[len(prefix):]
        if not name or entry.is_dir():
            continue
        parts = PurePosixPath(name).parts
        if not parts or any(part in ('', '.', '..') or ':' in part for part in parts) or name.startswith('/') or stat.S_ISLNK(entry.external_attr >> 16):
            raise RuntimeError('Archive contains an unsafe target.')
        normalized = '/'.join(parts)
        if normalized.casefold() in seen or entry.flag_bits & 1:
            raise RuntimeError('Archive has a duplicate or encrypted target.')
        seen.add(normalized.casefold())
        expanded += entry.file_size
        if len(seen) > 400 or expanded > 512 * 1024 * 1024:
            raise RuntimeError('Archive exceeds the bounded package limit.')
        entries.append((entry, normalized))
    if not entries:
        raise RuntimeError('Archive has no usable files.')
    return entries


def extract_checked(archive_path, target, pin):
    verify_file(archive_path, pin)
    target = Path(target).resolve()
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive_entries(archive, pin['archivePrefix'])
        if archive.testzip() is not None:
            raise RuntimeError('Archive CRC verification failed.')
        for entry, name in entries:
            file = inside(target / name, target)
            file.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, file.open('xb') as output:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    output.write(block)


def verify_extracted(archive_path, target, pin):
    verify_file(archive_path, pin)
    with zipfile.ZipFile(archive_path) as archive:
        for entry, name in archive_entries(archive, pin['archivePrefix']):
            file = inside(Path(target) / name, target)
            if file.is_symlink() or not file.is_file() or file.stat().st_size != entry.file_size:
                raise RuntimeError('An installed package file is missing or changed.')
            expected = hashlib.sha256()
            with archive.open(entry) as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    expected.update(block)
            if digest_file(file) != expected.hexdigest():
                raise RuntimeError('An installed package file differs from its pinned archive.')


def write_profile(package, models):
    package, models = Path(package), Path(models)
    config = json.loads((package / 'resources' / 'defaults.json').read_text(encoding='utf-8'))
    config.update(host='127.0.0.1', broadcast=False, auto_check_model_updates=False,
                  auto_update_models=False, offline=True, no_fetch_executables=True,
                  models_dir=str(models.resolve()), extra_models_dir='', cloud_providers=[],
                  max_loaded_models=1, ctx_size=2048, log_level='warning', inhibit_suspend=False)
    config['telemetry']['enabled'] = False
    config['llamacpp'].update(backend='vulkan', prefer_system=False,
                             args='--threads 4 --batch-size 128 --ubatch-size 128 --parallel 1 --cache-ram 0 --cache-type-k f16 --cache-type-v f16')
    with (package / 'config.json').open('x', encoding='utf-8') as file:
        json.dump(config, file, indent=2)
        file.write('\n')


def verify_runtime(root, package, model, manifest=None):
    lock = manifest or pins()
    root = Path(root).resolve()
    package, model = inside(package, root), inside(model, root)
    verify_extracted(root / 'archives' / lock['lemonade']['file'], package, lock['lemonade'])
    verify_extracted(root / 'archives' / lock['backend']['file'], package / 'bin' / 'llamacpp' / 'vulkan', lock['backend'])
    verify_file(model, lock['model'])
    if (package / 'bin' / 'llamacpp' / 'vulkan' / 'version.txt').read_text(encoding='utf-8').strip() != lock['backend']['version']:
        raise RuntimeError('Backend version metadata differs from its pinned source.')
    models = model.parents[3]
    if model.relative_to(models).as_posix() != lock['model']['cachePath']:
        raise RuntimeError('Model cache layout does not match the pinned runtime catalog layout.')
    config = json.loads((package / 'config.json').read_text(encoding='utf-8'))
    expected = {'host':'127.0.0.1','broadcast':False,'offline':True,'no_fetch_executables':True,
                'auto_check_model_updates':False,'auto_update_models':False,'max_loaded_models':1,
                'ctx_size':2048,'extra_models_dir':'','cloud_providers':[]}
    if any(config.get(key) != value for key, value in expected.items()) or config.get('telemetry',{}).get('enabled') is not False or config.get('llamacpp',{}).get('backend') != 'vulkan' or config['llamacpp'].get('prefer_system') is not False or config['llamacpp'].get('args') != '--threads 4 --batch-size 128 --ubatch-size 128 --parallel 1 --cache-ram 0 --cache-type-k f16 --cache-type-v f16' or Path(config.get('models_dir','')).resolve() != models.resolve():
        raise RuntimeError('The private offline runtime profile differs; no automatic repair was made.')
    return package, model
