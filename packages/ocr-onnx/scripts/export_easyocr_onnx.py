#!/usr/bin/env python3
"""Export EasyOCR models to ONNX format for @qvac/ocr-onnx.

Exports the CRAFT text detector and script-family recognizers to ONNX format
with tensor names and dynamic axes matching the @qvac/ocr-onnx C++ addon.

Detector:
  - Input:  "input"   [batch, 3, height, width]   (dynamic H/W)
  - Output: "output"  [batch, H/2, W/2, 2]        (textMap + linkMap)
  - Output: "feature" [batch, channels, H/2, W/2]

Recognizers (dynamic-width):
  - Input:  "image"   [batch, 1, 64, width]        (dynamic batch + width)
  - Output: "output"  [batch, sequence, num_classes]

Usage:
    python export_easyocr_onnx.py -o ./models              # all models
    python export_easyocr_onnx.py -m latin korean -o ./out  # specific recognizers
    python export_easyocr_onnx.py --detector-only -o ./out  # detector only
    python export_easyocr_onnx.py --verify ./s3_models      # compare checksums
"""

import argparse
import hashlib
import os
import sys

import torch
import torch.nn.functional as F
import easyocr

# ---------------------------------------------------------------------------
# Model configuration
# ---------------------------------------------------------------------------

# Maps QVAC script-family names to a representative EasyOCR language code.
# EasyOCR uses one recognizer model per script family; any language from the
# family triggers downloading the same model.
SCRIPT_FAMILIES = {
    'latin':      {'lang': 'fr',     'filename': 'recognizer_latin.onnx'},
    'korean':     {'lang': 'ko',     'filename': 'recognizer_korean.onnx'},
    'arabic':     {'lang': 'ar',     'filename': 'recognizer_arabic.onnx'},
    'cyrillic':   {'lang': 'ru',     'filename': 'recognizer_cyrillic.onnx'},
    'devanagari': {'lang': 'hi',     'filename': 'recognizer_devanagari.onnx'},
    'bengali':    {'lang': 'bn',     'filename': 'recognizer_bengali.onnx'},
    'thai':       {'lang': 'th',     'filename': 'recognizer_thai.onnx'},
    'zh_sim':     {'lang': 'ch_sim', 'filename': 'recognizer_zh_sim.onnx'},
    'zh_tra':     {'lang': 'ch_tra', 'filename': 'recognizer_zh_tra.onnx'},
    'japanese':   {'lang': 'ja',     'filename': 'recognizer_japanese.onnx'},
    'tamil':      {'lang': 'ta',     'filename': 'recognizer_tamil.onnx'},
    'telugu':     {'lang': 'te',     'filename': 'recognizer_telugu.onnx'},
    'kannada':    {'lang': 'kn',     'filename': 'recognizer_kannada.onnx'},
}

DETECTOR_FILENAME = 'detector_craft.onnx'
RECOGNIZER_HEIGHT = 64
DEFAULT_OPSET = 14

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def sha256_file(path):
    """Compute SHA-256 checksum of a file."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def get_detector_model(reader):
    """Extract the CRAFT detector model from an EasyOCR Reader."""
    if hasattr(reader, 'detector'):
        return reader.detector
    raise AttributeError(
        'Cannot find detector model on EasyOCR Reader. '
        'Check EasyOCR version compatibility (requires >= 1.7.0).'
    )


def get_recognizer_model(reader):
    """Extract the recognizer model from an EasyOCR Reader."""
    if hasattr(reader, 'recognizer') and hasattr(reader.recognizer, 'eval'):
        return reader.recognizer
    raise AttributeError(
        'Cannot find recognizer model on EasyOCR Reader. '
        'Check EasyOCR version compatibility (requires >= 1.7.0).'
    )


def _load_recognizer_direct(model_path, device='cpu'):
    """Load a recognizer model directly from its checkpoint file.

    Infers architecture parameters (hidden size, num_class) from the
    checkpoint rather than relying on EasyOCR's character config, which
    can be out of sync with the pre-trained weights for some languages.

    Detects whether the model uses VGG (gen2) or ResNet (gen1) feature
    extraction based on checkpoint key names.
    """
    state_dict = torch.load(model_path, map_location=device, weights_only=True)

    # Strip 'module.' prefix if present (DataParallel wrapper)
    cleaned = {}
    for k, v in state_dict.items():
        cleaned[k.replace('module.', '')] = v

    # Infer architecture from checkpoint shapes
    num_class = cleaned['Prediction.weight'].shape[0]
    hidden_size = cleaned['SequenceModeling.0.rnn.weight_ih_l0'].shape[0] // 4
    output_channel = cleaned['SequenceModeling.0.rnn.weight_ih_l0'].shape[1]

    # Detect feature extractor type: ResNet (gen1) has 'layer1' keys,
    # VGG (gen2) has sequential indices like 'ConvNet.0'
    uses_resnet = any('layer1' in k for k in cleaned if 'FeatureExtraction' in k)

    if uses_resnet:
        from easyocr.model.model import Model
    else:
        from easyocr.model.vgg_model import Model

    model = Model(
        input_channel=1,
        output_channel=output_channel,
        hidden_size=hidden_size,
        num_class=num_class,
    )
    model.load_state_dict(cleaned)
    model.to(device)
    model.eval()
    return model


def _create_reader_with_fallback(lang, gpu, quantize=False):
    """Create an EasyOCR Reader, falling back to direct loading on mismatch.

    Some EasyOCR models have character-set mismatches between the config and
    the pre-trained weights (e.g. Tamil, Telugu, Kannada). When Reader fails,
    we load the recognizer directly from the checkpoint with architecture
    params inferred from the weights.
    """
    try:
        return easyocr.Reader([lang], gpu=gpu, verbose=False, quantize=quantize)
    except RuntimeError as e:
        if 'size mismatch' not in str(e):
            raise

    # Load detector normally, but manually load the recognizer
    reader = easyocr.Reader(
        [lang], gpu=gpu, verbose=False, quantize=quantize,
        detector=True, recognizer=False,
    )

    # Find the model path EasyOCR would have used
    model_dir = reader.model_storage_directory
    model_lang = getattr(reader, 'model_lang', None)
    model_path = None

    if model_lang:
        # EasyOCR stores model files as <model_lang>.pth
        candidate = os.path.join(model_dir, f'{model_lang}.pth')
        if os.path.exists(candidate):
            model_path = candidate

    if model_path is None:
        # Try finding the downloaded model by language code
        import glob
        candidates = glob.glob(os.path.join(model_dir, f'*{lang}*'))
        if candidates:
            model_path = candidates[0]

    if model_path is None or not os.path.exists(model_path):
        raise FileNotFoundError(
            f'Could not find recognizer checkpoint for lang={lang!r} '
            f'in {model_dir}. Ensure EasyOCR has downloaded the model.'
        )

    device = 'cuda' if gpu and torch.cuda.is_available() else 'cpu'
    reader.recognizer = _load_recognizer_direct(model_path, device)
    print('    (loaded recognizer directly due to character-set mismatch)')
    return reader


def _replace_relu_with_functional(model):
    """Replace nn.ReLU modules with functional F.relu throughout the model.

    The ONNX tracer includes module paths in node names: a module-based
    ``self.relu(x)`` produces names like ``/relu/Relu_output_0``, while
    functional ``F.relu(x)`` produces ``/Relu_output_0``.  The S3 reference
    models use functional ReLU, so we patch the model to match.
    """
    targets = [
        m for m in model.modules()
        if hasattr(m, 'relu') and isinstance(m.relu, torch.nn.ReLU)
    ]
    for module in targets:
        inplace = module.relu.inplace
        del module._modules['relu']
        module.relu = lambda x, _inp=inplace: F.relu(x, inplace=_inp)


class _RecognizerExportWrapper(torch.nn.Module):
    """Wrapper that adapts the EasyOCR recognizer for ONNX export.

    Solves two issues with the raw EasyOCR Model:
    1. Model.forward(input, text) requires a `text` arg that CTC models
       don't use — this wrapper drops it so the ONNX model has one input.
    2. AdaptiveAvgPool2d((None, 1)) with dynamic width causes the legacy
       TorchScript ONNX exporter to fail. We replace it with an equivalent
       mean(dim=3) which exports cleanly.
    """

    def __init__(self, model):
        super().__init__()
        self.FeatureExtraction = model.FeatureExtraction
        self.SequenceModeling = model.SequenceModeling
        self.Prediction = model.Prediction
        _replace_relu_with_functional(self)

    def forward(self, image):
        visual_feature = self.FeatureExtraction(image)  # [B, C, H, W]
        # Equivalent to AdaptiveAvgPool2d((None, 1)) followed by squeeze + permute.
        # Mean over height dim, squeeze it, then transpose to [B, W, C] for LSTM.
        visual_feature = visual_feature.mean(dim=2, keepdim=True)  # [B, C, 1, W]
        visual_feature = visual_feature.squeeze(2)  # [B, C, W]
        visual_feature = visual_feature.permute(0, 2, 1)  # [B, W, C]
        contextual_feature = self.SequenceModeling(visual_feature)
        prediction = self.Prediction(contextual_feature.contiguous())
        return prediction


# ---------------------------------------------------------------------------
# Export functions
# ---------------------------------------------------------------------------


def export_detector(reader, output_dir, opset_version=DEFAULT_OPSET):
    """Export the CRAFT text detector to ONNX.

    The detector accepts a normalized RGB image and produces a text score map
    (textMap) and a link score map (linkMap) as a 2-channel output, plus an
    intermediate feature map.
    """
    model = get_detector_model(reader)
    model.eval()

    output_path = os.path.join(output_dir, DETECTOR_FILENAME)
    dummy_input = torch.randn(1, 3, 800, 800)

    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy_input,
            output_path,
            input_names=['input'],
            output_names=['output', 'feature'],
            dynamic_axes={
                'input': {0: 'batch_size', 2: 'height', 3: 'width'},
                'output': {0: 'batch_size', 1: 'height', 2: 'width'},
                'feature': {0: 'batch_size', 2: 'height', 3: 'width'},
            },
            opset_version=opset_version,
            do_constant_folding=True,
            dynamo=False,
        )

    checksum = sha256_file(output_path)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f'  {DETECTOR_FILENAME} ({size_mb:.1f} MB, sha256={checksum[:16]}...)')
    return output_path


def export_recognizer(reader, script_name, output_dir, opset_version=DEFAULT_OPSET):
    """Export a CRNN recognizer to ONNX with dynamic width.

    The recognizer accepts a grayscale image with fixed height (64px) and
    variable width, producing per-timestep class probabilities for CTC decoding.
    """
    model = _RecognizerExportWrapper(get_recognizer_model(reader))
    model.eval()

    info = SCRIPT_FAMILIES[script_name]
    output_path = os.path.join(output_dir, info['filename'])
    dummy_input = torch.randn(1, 1, RECOGNIZER_HEIGHT, 256)

    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy_input,
            output_path,
            input_names=['image'],
            output_names=['output'],
            dynamic_axes={
                'image': {0: 'batch_size', 3: 'width'},
                'output': {0: 'batch_size', 1: 'seq_len'},
            },
            opset_version=opset_version,
            do_constant_folding=True,
            dynamo=False,
        )

    checksum = sha256_file(output_path)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f'  {info["filename"]} ({size_mb:.1f} MB, sha256={checksum[:16]}...)')
    return output_path


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify_checksums(output_dir, reference_dir):
    """Compare SHA-256 checksums of exported models against reference models."""
    print(f'\nVerifying checksums against {reference_dir}...')

    all_filenames = [DETECTOR_FILENAME] + [
        v['filename'] for v in SCRIPT_FAMILIES.values()
    ]
    all_match = True
    checked = 0

    for filename in all_filenames:
        exported = os.path.join(output_dir, filename)
        reference = os.path.join(reference_dir, filename)

        if not os.path.exists(exported):
            continue
        if not os.path.exists(reference):
            print(f'  SKIP {filename} (no reference file)')
            continue

        exported_hash = sha256_file(exported)
        reference_hash = sha256_file(reference)
        checked += 1

        if exported_hash == reference_hash:
            print(f'  OK   {filename}')
        else:
            print(f'  FAIL {filename}')
            print(f'       exported:  {exported_hash}')
            print(f'       reference: {reference_hash}')
            all_match = False

    if checked == 0:
        print('  No matching files found to verify.')
        return False

    return all_match


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description='Export EasyOCR models to ONNX format for @qvac/ocr-onnx',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        '--output-dir', '-o',
        default='./exported_models',
        help='Output directory for ONNX models (default: ./exported_models)',
    )
    parser.add_argument(
        '--models', '-m',
        nargs='+',
        choices=list(SCRIPT_FAMILIES.keys()) + ['all'],
        default=['all'],
        help='Recognizer models to export (default: all)',
    )
    parser.add_argument(
        '--detector-only',
        action='store_true',
        help='Export only the CRAFT detector, skip recognizers',
    )
    parser.add_argument(
        '--skip-detector',
        action='store_true',
        help='Skip the detector, export recognizers only',
    )
    parser.add_argument(
        '--opset-version',
        type=int,
        default=DEFAULT_OPSET,
        help=f'ONNX opset version (default: {DEFAULT_OPSET})',
    )
    parser.add_argument(
        '--verify',
        metavar='REFERENCE_DIR',
        help='Verify exported checksums against reference ONNX models in this directory',
    )
    parser.add_argument(
        '--gpu',
        action='store_true',
        help='Use GPU for model loading (default: CPU)',
    )

    args = parser.parse_args()

    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    if args.detector_only:
        recognizers = []
    elif 'all' in args.models:
        recognizers = list(SCRIPT_FAMILIES.keys())
    else:
        recognizers = args.models

    device = 'GPU' if args.gpu else 'CPU'
    print(f'Output:  {output_dir}')
    print(f'Opset:   {args.opset_version}')
    print(f'Device:  {device}')

    exported = []

    # quantize=False is required for ONNX export (quantized models produce
    # torch._C.ScriptObject which cannot be traced by the ONNX exporter)

    # --- Detector ---
    if not args.skip_detector:
        print('\nExporting CRAFT detector...')
        reader = _create_reader_with_fallback('en', gpu=args.gpu)
        path = export_detector(reader, output_dir, args.opset_version)
        exported.append(path)
        del reader

    # --- Recognizers ---
    for script_name in recognizers:
        info = SCRIPT_FAMILIES[script_name]
        print(f'\nExporting {script_name} recognizer (lang={info["lang"]})...')
        reader = _create_reader_with_fallback(info['lang'], gpu=args.gpu)
        path = export_recognizer(reader, script_name, output_dir, args.opset_version)
        exported.append(path)
        del reader

    print(f'\nExported {len(exported)} model(s) to {output_dir}')

    # --- Verify ---
    if args.verify:
        success = verify_checksums(output_dir, args.verify)
        if not success:
            print('\nChecksum verification FAILED.')
            return 1
        print('\nAll checksums match.')

    return 0


if __name__ == '__main__':
    sys.exit(main())
