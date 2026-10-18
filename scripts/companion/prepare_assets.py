"""Explicit offline preparation from user-supplied archives and model. Never downloads or starts a process."""
import argparse
import shutil
from pathlib import Path
from assets import pins, runtime_root, inside, verify_file, extract_checked, write_profile


def prepare(root, lemonade_archive, backend_archive, model_file):
    root = runtime_root(root)
    lock = pins()
    for path, name in [(lemonade_archive,'lemonade'),(backend_archive,'backend'),(model_file,'model')]:
        verify_file(path, lock[name])
    package = inside(root / 'vendor' / ('lemonade-' + lock['lemonade']['version']), root)
    if package.exists():
        raise RuntimeError('The target asset package already exists; it was not overwritten.')
    package.mkdir(parents=True, exist_ok=False)
    # Failed preparation retains this private partial directory for explicit inspection.
    archives = root / 'archives'
    archives.mkdir(parents=True, exist_ok=True)
    for source, name in [(lemonade_archive,'lemonade'),(backend_archive,'backend')]:
        target = archives / lock[name]['file']
        if target.exists():
            verify_file(target, lock[name])
        else:
            with Path(source).open('rb') as input_file, target.open('xb') as output:
                shutil.copyfileobj(input_file, output, 1024 * 1024)
            verify_file(target, lock[name])
    extract_checked(archives / lock['lemonade']['file'], package, lock['lemonade'])
    backend = package / 'bin' / 'llamacpp' / 'vulkan'
    backend.mkdir(parents=True, exist_ok=False)
    extract_checked(archives / lock['backend']['file'], backend, lock['backend'])
    (backend / 'version.txt').write_text(lock['backend']['version'] + '\n', encoding='utf-8')
    models = package / 'models'
    target_model = models / lock['model']['cachePath']
    target_model.parent.mkdir(parents=True, exist_ok=False)
    with Path(model_file).open('rb') as source, target_model.open('xb') as output:
        shutil.copyfileobj(source, output, 1024 * 1024)
    verify_file(target_model, lock['model'])
    refs = models / ('models--' + lock['model']['repo'].replace('/', '--')) / 'refs'
    refs.mkdir(parents=True, exist_ok=True)
    (refs / 'main').write_text(lock['model']['revision'], encoding='utf-8')
    write_profile(package, models)
    return package, target_model


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-root')
    parser.add_argument('--lemonade-archive',required=True)
    parser.add_argument('--vulkan-archive',required=True)
    parser.add_argument('--model-file',required=True)
    args=parser.parse_args()
    try:
        prepare(args.runtime_root,args.lemonade_archive,args.vulkan_archive,args.model_file)
        print('Pinned assets prepared under the ignored runtime directory. No service was started.')
        return 0
    except Exception:
        print('Asset preparation failed. Source inputs and any private partial directory were retained; check the pinned sources and target layout.')
        return 1


if __name__=='__main__':
    raise SystemExit(main())
