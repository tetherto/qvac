import os
from pathlib import Path


workspace = Path(os.environ['GITHUB_WORKSPACE'])
source = workspace / 'q28085-runtime/node_modules'
target = workspace / 'q28085-source/packages/diffusion-cpp/node_modules'

for entry in source.iterdir():
    if entry.name.startswith('.'):
        continue
    if entry.name == '@qvac':
        (target / entry.name).mkdir(parents=True, exist_ok=True)
        for scoped in entry.iterdir():
            (target / entry.name / scoped.name).symlink_to(scoped, target_is_directory=True)
    else:
        target.mkdir(parents=True, exist_ok=True)
        (target / entry.name).symlink_to(entry, target_is_directory=True)
