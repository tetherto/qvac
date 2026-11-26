from tetherto.qvac_sdk._generated.models._internal import (
    LoadModelSrcRequestSdcppGenerationModelConfig,
)

UNET = (
    "registry://s3/qvac_models_compiled/ggml/stable-diffusion/2026-11-19/"
    "sd21base_unet_p6.mlmodelc"
)


def test_core_ml_sidecar_sources_serialize_under_their_wire_names() -> None:
    payload = {
        "prediction": "eps",
        "taesdModelSrc": "/models/taesd.safetensors",
        "coremlUnetModelSrc": UNET,
        "coremlTaeDecoderModelSrc": {"src": "/models/taesd_decoder.mlmodelc"},
    }
    config = LoadModelSrcRequestSdcppGenerationModelConfig.model_validate(payload)

    assert config.coreml_unet_model_src is not None
    assert config.model_dump(mode="json", by_alias=True, exclude_unset=True) == payload
