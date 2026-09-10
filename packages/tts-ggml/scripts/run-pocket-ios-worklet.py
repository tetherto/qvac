#!/usr/bin/env python3
"""Build a local Bare Kit host and test the installed Pocket simulator prebuild.

Requires Xcode, a booted arm64 iOS Simulator, a converted model bundle,
react-native-bare-kit with its BareKit.xcframework, and installed bare-pack /
bare-link tooling. No app checkout is changed, no assets are downloaded, and
no simulator is booted or shut down by this script.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import struct
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--simulator', required=True, help='UDID of a booted iOS Simulator')
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--bare-kit', type=Path, required=True, help='react-native-bare-kit package directory')
    parser.add_argument('--tool-modules', type=Path, required=True, help='node_modules containing bare-link and bare-pack')
    parser.add_argument('--output', type=Path, required=True, help='new directory for host, frameworks and reports')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent.parent
    bundle, kit, modules, output = (x.resolve() for x in (args.bundle, args.bare_kit, args.tool_modules, args.output))
    for name in ('flow-lm.gguf', 'mimi.gguf', 'frontend.json', 'voice.gguf'):
        if not (bundle/name).is_file():
            parser.error(f'missing model artifact: {bundle/name}')
    framework_dir = kit/'ios/BareKit.xcframework/ios-arm64_x86_64-simulator'
    required = [framework_dir/'BareKit.framework/BareKit', modules/'bare-pack/bin.js',
                modules/'bare-link/index.js', source/'prebuilds/ios-arm64-simulator/qvac__tts-ggml.bare']
    for path in required:
        if not path.is_file():
            parser.error(f'missing dependency: {path}')
    devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'booted', '--json']))
    if not any(d['udid'] == args.simulator and d['state'] == 'Booted'
               for group in devices['devices'].values() for d in group):
        parser.error('the requested simulator must already be booted')
    if output.exists():
        parser.error('output directory already exists; use a new path to preserve prior evidence')
    output.mkdir(parents=True)

    def run(command, log, **options):
        with (output/log).open('w') as stream:
            subprocess.run([str(x) for x in command], cwd=source, stdout=stream,
                           stderr=subprocess.STDOUT, check=True, **options)

    pack_major = int(json.loads((modules/'bare-pack/package.json').read_text())['version'].split('.')[0])
    link_major = int(json.loads((modules/'bare-link/package.json').read_text())['version'].split('.')[0])
    if pack_major < 2 or link_major < 3:
        parser.error('current pnpm workspace needs bare-pack >= 2 and bare-link >= 3')
    run(['node', source/'scripts/prepare-pocket-worklet.cjs', source, output, modules], 'pack-link.log')
    run(['xcrun', '--sdk', 'iphonesimulator', 'clang++', '-std=c++17',
         '-target', 'arm64-apple-ios15.0-simulator', source/'test/mobile/pocket-worklet-host.cpp',
         '-F', framework_dir, '-framework', 'Foundation', '-framework', 'BareKit',
         '-Wl,-rpath,'+str(framework_dir), '-Wl,-rpath,'+str(output/'frameworks'),
         '-o', output/'host'], 'host-build.log')
    frameworks = sorted((output/'frameworks').glob('*.framework'))
    env = dict(os.environ, SIMCTL_CHILD_QVAC_POCKET_MODEL_DIR=str(bundle),
               SIMCTL_CHILD_QVAC_POCKET_AUDIO_OUTPUT=str(output/'pocket-ios-worklet.wav'))
    run(['xcrun', 'simctl', 'spawn', args.simulator, output/'host', output/'test.bundle',
         *(p/p.stem for p in frameworks)], 'run.log', env=env)
    lines = (output/'run.log').read_text().splitlines()
    results = [json.loads(line.removeprefix('WORKLET_RESULT '))
               for line in lines if line.startswith('WORKLET_RESULT ')]
    if len(results) != 1 or results[0].get('passed') is not True or results[0].get('assertions', 0) <= 0:
        raise RuntimeError('worklet did not return one successful non-skipped test result')
    with wave.open(str(output/'pocket-ios-worklet.wav'), 'rb') as wav:
        rate, channels, width, frames = wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getnframes()
        if rate != 24000 or channels != 1 or width != 2 or frames <= 0:
            raise RuntimeError('invalid worklet WAV format')
        pcm = [sample[0] for sample in struct.iter_unpack('<h', wav.readframes(frames))]
        if len(pcm) != frames or not any(pcm):
            raise RuntimeError('worklet WAV is truncated or silent')
    result = results[0]
    result['audio'] = dict(file='pocket-ios-worklet.wav', sample_rate=rate, frames=frames,
                          duration_seconds=frames/rate, peak=max(abs(s) for s in pcm)/32768,
                          clipping_fraction=sum(s in (-32768, 32767) for s in pcm)/frames,
                          reference='Hello! We can generate speech with Fabric.')
    result.update(simulator=args.simulator, scope='packaged addon in standalone iOS Simulator Bare Kit worklet')
    (output/'result.json').write_text(json.dumps(result, indent=2)+'\n')
    (output/'tap.log').write_text('\n'.join(result['tap'])+'\n')
    print(f"Pocket iOS worklet passed {result['assertions']} assertions. Report: {output/'result.json'}")


if __name__ == '__main__':
    main()
