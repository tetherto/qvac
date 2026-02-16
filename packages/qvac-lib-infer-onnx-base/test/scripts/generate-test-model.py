#!/usr/bin/env python3
"""
Generate a simple ONNX model for testing.
Creates a model that adds two float tensors together.
"""

import onnx
from onnx import TensorProto, helper
import os
import sys

def create_add_model(output_path):
    """Create a simple add model: output = input_a + input_b"""

    # Define inputs
    input_a = helper.make_tensor_value_info('input_a', TensorProto.FLOAT, [1, 4])
    input_b = helper.make_tensor_value_info('input_b', TensorProto.FLOAT, [1, 4])

    # Define output
    output = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 4])

    # Create Add node
    add_node = helper.make_node(
        'Add',
        inputs=['input_a', 'input_b'],
        outputs=['output'],
        name='add_node'
    )

    # Create the graph
    graph_def = helper.make_graph(
        nodes=[add_node],
        name='add_graph',
        inputs=[input_a, input_b],
        outputs=[output]
    )

    # Create the model
    model_def = helper.make_model(graph_def, producer_name='test-model-generator')
    model_def.opset_import[0].version = 13

    # Validate and save
    onnx.checker.check_model(model_def)
    onnx.save(model_def, output_path)
    print(f"Created model: {output_path}")


def create_multiply_model(output_path):
    """Create a simple multiply model: output = input * 2.0"""

    # Define input
    input_tensor = helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 4, 4])

    # Define output
    output_tensor = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 4, 4])

    # Create constant for multiplication
    multiplier = helper.make_tensor(
        'multiplier',
        TensorProto.FLOAT,
        [1],
        [2.0]
    )

    # Create Mul node
    mul_node = helper.make_node(
        'Mul',
        inputs=['input', 'multiplier'],
        outputs=['output'],
        name='mul_node'
    )

    # Create the graph with initializer
    graph_def = helper.make_graph(
        nodes=[mul_node],
        name='multiply_graph',
        inputs=[input_tensor],
        outputs=[output_tensor],
        initializer=[multiplier]
    )

    # Create the model
    model_def = helper.make_model(graph_def, producer_name='test-model-generator')
    model_def.opset_import[0].version = 13

    # Validate and save
    onnx.checker.check_model(model_def)
    onnx.save(model_def, output_path)
    print(f"Created model: {output_path}")


def main():
    output_dir = sys.argv[1] if len(sys.argv) > 1 else 'models'
    os.makedirs(output_dir, exist_ok=True)

    create_add_model(os.path.join(output_dir, 'add_test.onnx'))
    create_multiply_model(os.path.join(output_dir, 'multiply_test.onnx'))

    print(f"\nTest models created in: {output_dir}")


if __name__ == '__main__':
    main()
