"""Regenerate the synthetic encoder-interface fixture; no trained weights are used."""

import argparse
from pathlib import Path

import coremltools as ct
from coremltools.converters.mil import Builder as mb

MEL_CHANNELS = 80
MEL_FRAMES = 3000
ENCODER_CHANNELS = 384
ENCODER_FRAMES = 1500


@mb.program(input_specs=[mb.TensorSpec(shape=(1, MEL_CHANNELS, MEL_FRAMES))])
def encoder(logmel_data):
    frames = mb.slice_by_index(
        x=logmel_data,
        begin=[0, 0, 0],
        end=[1, MEL_CHANNELS, MEL_FRAMES],
        stride=[1, 1, 2],
    )
    channel_mean = mb.reduce_mean(x=frames, axes=[1], keep_dims=True)
    channels = mb.tile(x=channel_mean, reps=[1, ENCODER_CHANNELS, 1])
    return mb.transpose(x=channels, perm=[0, 2, 1], name="output")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    model = ct.convert(
        encoder,
        convert_to="neuralnetwork",
        minimum_deployment_target=ct.target.macOS11,
        skip_model_load=True,
    )
    spec = model.get_spec()
    spec.description.metadata.Clear()
    spec.description.output[0].type.multiArrayType.shape.extend(
        [1, ENCODER_FRAMES, ENCODER_CHANNELS]
    )
    ct.utils.save_spec(spec, str(args.output))


if __name__ == "__main__":
    main()
