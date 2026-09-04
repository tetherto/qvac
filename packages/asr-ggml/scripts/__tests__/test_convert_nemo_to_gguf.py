import importlib.util
import sys
import types
import unittest
from pathlib import Path


def install_gguf_stub():
    gguf = types.ModuleType("gguf")
    gguf.GGMLQuantizationType = types.SimpleNamespace(
        Q8_0=1,
        Q5_0=2,
        Q4_0=3,
    )
    gguf.LlamaFileType = types.SimpleNamespace(
        ALL_F32=1,
        MOSTLY_F16=2,
        MOSTLY_Q8_0=3,
        MOSTLY_Q5_0=4,
        MOSTLY_Q4_0=5,
    )
    sys.modules["gguf"] = gguf


def install_torch_stub():
    torch = types.ModuleType("torch")
    torch.Tensor = object
    sys.modules["torch"] = torch


def install_numpy_stub():
    numpy = types.ModuleType("numpy")
    numpy.ndarray = object
    numpy.float32 = object
    sys.modules["numpy"] = numpy


def install_yaml_stub():
    sys.modules["yaml"] = types.ModuleType("yaml")


try:
    import gguf
except ModuleNotFoundError:
    install_gguf_stub()

try:
    import torch
except ModuleNotFoundError:
    install_torch_stub()

try:
    import numpy
except ModuleNotFoundError:
    install_numpy_stub()

try:
    import yaml
except ModuleNotFoundError:
    install_yaml_stub()


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))
SCRIPT = SCRIPTS_DIR / "convert-nemo-to-gguf.py"
SPEC = importlib.util.spec_from_file_location("convert_nemo_to_gguf", SCRIPT)
CONVERTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONVERTER)


def unified_config():
    return {
        "target": "nemo.collections.asr.models.rnnt_bpe_models.EncDecRNNTBPEModel",
        "model_defaults": {
            "enc_hidden": 1024,
            "pred_hidden": 640,
            "joint_hidden": 640,
        },
        "decoder": {
            "vocab_size": 1024,
            "prednet": {
                "pred_hidden": 640,
                "pred_rnn_layers": 2,
            },
        },
        "joint": {
            "num_classes": 1024,
            "jointnet": {
                "joint_hidden": 640,
            },
        },
        "decoding": {
            "greedy": {
                "max_symbols": 10,
            },
        },
        "loss": {
            "loss_name": "default",
        },
        "labels": ["<unk>", "word"],
    }


class RecordingWriter:
    def __init__(self):
        self.values = {}

    def add_uint32(self, name, value):
        self.values[name] = value

    def add_array(self, name, value):
        self.values[name] = value

    def add_string(self, name, value):
        self.values[name] = value


class FakeTensor:
    def __init__(self, shape):
        self.shape = shape


def transducer_state_dict():
    return {
        "decoder.prediction.embed.weight": "embed",
        "decoder.prediction.dec_rnn.lstm.weight_ih_l0": "w_ih_0",
        "decoder.prediction.dec_rnn.lstm.weight_hh_l0": "w_hh_0",
        "decoder.prediction.dec_rnn.lstm.bias_ih_l0": "b_ih_0",
        "decoder.prediction.dec_rnn.lstm.bias_hh_l0": "b_hh_0",
        "decoder.prediction.dec_rnn.lstm.weight_ih_l1": "w_ih_1",
        "decoder.prediction.dec_rnn.lstm.weight_hh_l1": "w_hh_1",
        "decoder.prediction.dec_rnn.lstm.bias_ih_l1": "b_ih_1",
        "decoder.prediction.dec_rnn.lstm.bias_hh_l1": "b_hh_1",
        "joint.enc.weight": "joint_enc_w",
        "joint.enc.bias": "joint_enc_b",
        "joint.pred.weight": "joint_pred_w",
        "joint.pred.bias": "joint_pred_b",
        "joint.joint_net.2.weight": "joint_out_w",
        "joint.joint_net.2.bias": "joint_out_b",
    }


def nemotron_config():
    config = unified_config()
    config.update(
        {
            "target": CONVERTER.NEMOTRON_TARGET,
            "num_prompts": 128,
            "encoder": {
                "n_layers": 24,
                "d_model": 1024,
                "n_heads": 8,
                "subsampling_factor": 8,
                "conv_kernel_size": 9,
                "att_context_style": "chunked_limited",
                "att_context_size": [
                    [56, 3],
                    [56, 0],
                    [56, 6],
                    [56, 13],
                ],
                "conv_context_size": "causal",
                "causal_downsampling": True,
                "conv_norm_type": "layer_norm",
            },
            "model_defaults": {
                "initialize_prompt_feature": True,
                "num_prompts": 128,
                "prompt_dictionary": {
                    "en-US": 0,
                    "en": 0,
                    "auto": 101,
                },
            },
            "decoder": {
                "vocab_size": 13087,
                "prednet": {
                    "pred_hidden": 640,
                    "pred_rnn_layers": 2,
                },
            },
            "joint": {
                "num_classes": 13087,
                "jointnet": {
                    "encoder_hidden": 1024,
                    "pred_hidden": 640,
                    "joint_hidden": 640,
                },
            },
        },
    )
    return config


def nemotron_state_dict():
    shapes = {
        "prompt_kernel.0.weight": (2048, 1152),
        "prompt_kernel.0.bias": (2048,),
        "prompt_kernel.2.weight": (1024, 2048),
        "prompt_kernel.2.bias": (1024,),
        "decoder.prediction.embed.weight": (13088, 640),
        "decoder.prediction.dec_rnn.lstm.weight_ih_l0": (2560, 640),
        "decoder.prediction.dec_rnn.lstm.weight_hh_l0": (2560, 640),
        "decoder.prediction.dec_rnn.lstm.bias_ih_l0": (2560,),
        "decoder.prediction.dec_rnn.lstm.bias_hh_l0": (2560,),
        "decoder.prediction.dec_rnn.lstm.weight_ih_l1": (2560, 640),
        "decoder.prediction.dec_rnn.lstm.weight_hh_l1": (2560, 640),
        "decoder.prediction.dec_rnn.lstm.bias_ih_l1": (2560,),
        "decoder.prediction.dec_rnn.lstm.bias_hh_l1": (2560,),
        "joint.enc.weight": (640, 1024),
        "joint.enc.bias": (640,),
        "joint.pred.weight": (640, 640),
        "joint.pred.bias": (640,),
        "joint.joint_net.2.weight": (13088, 640),
        "joint.joint_net.2.bias": (13088,),
    }
    return {
        name: FakeTensor(shape)
        for name, shape in shapes.items()
    }


class ConverterRnntTests(unittest.TestCase):
    def test_detects_standard_rnnt(self):
        self.assertEqual(CONVERTER.detect_model_type(unified_config()), "rnnt")

    def test_keeps_tdt_detection(self):
        config = unified_config()
        config["model_defaults"]["tdt_durations"] = [0, 1, 2]
        self.assertEqual(CONVERTER.detect_model_type(config), "tdt")

    def test_keeps_eou_detection(self):
        config = unified_config()
        config["labels"] = ["<unk>", "<EOU>"]
        self.assertEqual(CONVERTER.detect_model_type(config), "eou")

    def test_writes_rnnt_metadata_without_durations(self):
        writer = RecordingWriter()
        CONVERTER.write_transducer_metadata(
            writer, unified_config(), "rnnt")

        self.assertEqual(writer.values["parakeet.rnnt.vocab_size"], 1024)
        self.assertEqual(writer.values["parakeet.rnnt.blank_id"], 1024)
        self.assertEqual(
            writer.values["parakeet.rnnt.max_symbols_per_step"], 10)
        self.assertFalse(
            any("duration" in name for name in writer.values))

    def test_writes_rnnt_tensor_namespace(self):
        names = []

        def record(name, value):
            names.append(name)

        CONVERTER.write_transducer_tensors(
            unified_config(),
            transducer_state_dict(),
            "rnnt",
            record,
            record,
        )

        self.assertIn("rnnt.predict.embed.weight", names)
        self.assertIn("rnnt.predict.lstm.1.w_hh", names)
        self.assertIn("rnnt.joint.out.weight", names)
        self.assertFalse(any(name.startswith("tdt.") for name in names))


class ConverterNemotronTests(unittest.TestCase):
    def test_detects_prompt_conditioned_nemotron_narrowly(self):
        self.assertEqual(
            CONVERTER.detect_model_type(nemotron_config()),
            "nemotron",
        )

        config = nemotron_config()
        config["target"] = (
            "example.EncDecRNNTBPEModelWithPrompt"
        )
        self.assertEqual(CONVERTER.detect_model_type(config), "rnnt")

    def test_validates_checkpoint_derived_contract(self):
        CONVERTER.validate_nemotron_contract(
            nemotron_config(),
            nemotron_state_dict(),
        )

    def test_rejects_incompatible_prompt_projection_shape(self):
        state_dict = nemotron_state_dict()
        state_dict["prompt_kernel.0.weight"] = FakeTensor((2048, 1024))

        with self.assertRaisesRegex(
            ValueError,
            r"prompt_kernel\.0\.weight shape=\(2048, 1024\)",
        ):
            CONVERTER.validate_nemotron_contract(
                nemotron_config(),
                state_dict,
            )

    def test_writes_locale_and_streaming_metadata_in_source_order(self):
        writer = RecordingWriter()

        CONVERTER.write_nemotron_metadata(
            writer,
            nemotron_config(),
        )

        self.assertEqual(
            writer.values[
                "parakeet.nemotron.allowed_right_context_frames"
            ],
            [0, 1, 3, 6, 13],
        )
        self.assertEqual(
            writer.values["parakeet.nemotron.allowed_chunk_ms"],
            [80, 160, 320, 560, 1120],
        )
        self.assertEqual(
            writer.values["parakeet.nemotron.locale_aliases"],
            ["en-US", "en", "auto"],
        )
        self.assertEqual(
            writer.values["parakeet.nemotron.locale_prompt_ids"],
            [0, 0, 101],
        )
        self.assertEqual(
            writer.values["parakeet.nemotron.max_symbols_per_step"],
            10,
        )

    def test_writes_rnnt_and_prompt_tensors_under_nemotron_namespace(self):
        names = []

        def record(name, value):
            names.append(name)

        config = nemotron_config()
        state_dict = transducer_state_dict()
        state_dict.update(
            {
                "prompt_kernel.0.weight": "prompt_0_w",
                "prompt_kernel.0.bias": "prompt_0_b",
                "prompt_kernel.2.weight": "prompt_2_w",
                "prompt_kernel.2.bias": "prompt_2_b",
            },
        )

        CONVERTER.write_transducer_tensors(
            config,
            state_dict,
            "nemotron",
            record,
            record,
        )
        CONVERTER.write_nemotron_prompt_tensors(
            state_dict,
            record,
            record,
        )

        self.assertIn("nemotron.predict.lstm.1.w_hh", names)
        self.assertIn("nemotron.joint.out.weight", names)
        self.assertIn("nemotron.prompt.proj.0.weight", names)
        self.assertIn("nemotron.prompt.proj.2.bias", names)

    def test_resolves_default_320ms_context_pair(self):
        self.assertEqual(
            CONVERTER.resolve_attention_context(
                nemotron_config()["encoder"],
                default_right=CONVERTER.NEMOTRON_DEFAULT_ATT_CONTEXT_RIGHT,
            ),
            (56, 3),
        )

    def test_pins_default_right_context_when_another_pair_is_listed_first(self):
        encoder = nemotron_config()["encoder"]
        encoder["att_context_size"] = [
            [56, 0],
            [56, 3],
            [56, 6],
            [56, 13],
        ]
        self.assertEqual(
            CONVERTER.resolve_attention_context(
                encoder,
                default_right=CONVERTER.NEMOTRON_DEFAULT_ATT_CONTEXT_RIGHT,
            ),
            (56, 3),
        )

    def test_supports_float_and_block_quantized_output_routes(self):
        for quant in ("f16", "q8_0", "q4_0"):
            with self.subTest(quant=quant):
                self.assertIn(quant, CONVERTER.FILE_TYPE_MAP)
        self.assertIn("q8_0", CONVERTER.QUANT_MAP)
        self.assertIn("q4_0", CONVERTER.QUANT_MAP)


if __name__ == "__main__":
    unittest.main()
