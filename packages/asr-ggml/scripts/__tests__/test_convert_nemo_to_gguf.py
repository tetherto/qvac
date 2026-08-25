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


if importlib.util.find_spec("gguf") is None:
    install_gguf_stub()

if importlib.util.find_spec("torch") is None:
    install_torch_stub()

if importlib.util.find_spec("numpy") is None:
    install_numpy_stub()

if importlib.util.find_spec("yaml") is None:
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
            writer, unified_config(), "rnnt"
        )

        self.assertEqual(writer.values["parakeet.rnnt.vocab_size"], 1024)
        self.assertEqual(writer.values["parakeet.rnnt.blank_id"], 1024)
        self.assertEqual(
            writer.values["parakeet.rnnt.max_symbols_per_step"], 10
        )
        self.assertFalse(
            any("duration" in name for name in writer.values)
        )

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


if __name__ == "__main__":
    unittest.main()
