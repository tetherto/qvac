"""
VAD Model Evaluation Metrics
============================

This module provides comprehensive evaluation metrics for Voice Activity Detection (VAD) models.
It includes accuracy, ROC-AUC, precision, recall, F1-score, and detailed per-file analysis.
"""

import numpy as np
from pathlib import Path
from typing import List, Dict, Tuple, Union
from sklearn.metrics import (
    accuracy_score,
    roc_auc_score,
    classification_report,
    confusion_matrix,
    precision_recall_fscore_support
)


def read_vad_output_file(file_path: str) -> np.ndarray:
    """
    Read VAD output file containing uint8 binary flags.

    Args:
        file_path (str): Path to the output file

    Returns:
        np.ndarray: Array of binary VAD flags (0=silence, 1=speech)
    """
    try:
        with open(file_path, 'rb') as f:
            data = f.read()
        return np.frombuffer(data, dtype=np.uint8)
    except Exception as e:
        print(f"Error reading file {file_path}: {e}")
        return np.array([], dtype=np.uint8)


def align_sequences(predictions: np.ndarray, references: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """
    Align prediction and reference sequences to same length for comparison.

    Args:
        predictions (np.ndarray): Predicted VAD labels
        references (np.ndarray): Reference VAD labels

    Returns:
        tuple: (aligned_predictions, aligned_references)
    """
    min_length = min(len(predictions), len(references))

    if min_length == 0:
        return np.array([]), np.array([])

    # Truncate both to the same length
    aligned_pred = predictions[:min_length]
    aligned_ref = references[:min_length]

    return aligned_pred, aligned_ref


def calculate_file_metrics(predictions: np.ndarray, references: np.ndarray, file_index: int = 0) -> Dict:
    """
    Calculate metrics for a single file.

    Args:
        predictions (np.ndarray): Predicted VAD labels
        references (np.ndarray): Reference VAD labels
        file_index (int): Index of the file for identification

    Returns:
        dict: Dictionary containing per-file metrics
    """
    if len(predictions) == 0 or len(references) == 0:
        return {
            'file_index': file_index,
            'error': 'Empty data',
            'valid': False
        }

    # Align sequences to same length
    aligned_pred, aligned_ref = align_sequences(predictions, references)

    if len(aligned_pred) == 0:
        return {
            'file_index': file_index,
            'error': 'No aligned data',
            'valid': False
        }

    try:
        # Basic metrics
        accuracy = accuracy_score(aligned_ref, aligned_pred)

        # ROC-AUC requires both classes to be present
        unique_ref = np.unique(aligned_ref)
        unique_pred = np.unique(aligned_pred)

        roc_auc = np.nan
        if len(unique_ref) > 1 and len(unique_pred) > 1:
            roc_auc = roc_auc_score(aligned_ref, aligned_pred)

        # Precision, Recall, F1 for both classes
        precision, recall, f1, support = precision_recall_fscore_support(
            aligned_ref, aligned_pred, average=None, zero_division=0
        )

        # Confusion matrix
        conf_matrix = confusion_matrix(aligned_ref, aligned_pred)

        # Speech-specific metrics (assuming class 1 is speech)
        speech_precision = precision[1] if len(precision) > 1 else 0
        speech_recall = recall[1] if len(recall) > 1 else 0
        speech_f1 = f1[1] if len(f1) > 1 else 0

        return {
            'file_index': file_index,
            'valid': True,
            'accuracy': accuracy,
            'roc_auc': roc_auc,
            'speech_precision': speech_precision,
            'speech_recall': speech_recall,
            'speech_f1': speech_f1,
            'length': len(aligned_pred),
            'speech_ratio_pred': np.mean(aligned_pred),
            'speech_ratio_ref': np.mean(aligned_ref),
            'confusion_matrix': conf_matrix,
            'length_diff': len(predictions) - len(references)
        }

    except Exception as e:
        return {
            'file_index': file_index,
            'error': str(e),
            'valid': False
        }


def calculate_overall_metrics(all_predictions: np.ndarray, all_references: np.ndarray) -> Dict:
    """
    Calculate overall metrics across all files.

    Args:
        all_predictions (np.ndarray): All predicted VAD labels concatenated
        all_references (np.ndarray): All reference VAD labels concatenated

    Returns:
        dict: Dictionary containing overall metrics
    """
    if len(all_predictions) == 0 or len(all_references) == 0:
        return {'error': 'No data available for overall metrics'}

    try:
        # Basic metrics
        overall_accuracy = accuracy_score(all_references, all_predictions)

        # ROC-AUC (only if both classes present)
        unique_ref = np.unique(all_references)
        unique_pred = np.unique(all_predictions)

        overall_roc_auc = np.nan
        if len(unique_ref) > 1 and len(unique_pred) > 1:
            overall_roc_auc = roc_auc_score(all_references, all_predictions)

        # Detailed classification report
        class_report = classification_report(
            all_references, all_predictions,
            target_names=['Silence', 'Speech'],
            output_dict=True,
            zero_division=0
        )

        # Confusion matrix
        conf_matrix = confusion_matrix(all_references, all_predictions)

        # Extract speech-specific metrics
        speech_metrics = class_report.get('Speech', {})
        speech_precision = speech_metrics.get('precision', 0)
        speech_recall = speech_metrics.get('recall', 0)
        speech_f1 = speech_metrics.get('f1-score', 0)

        # Silence-specific metrics
        silence_metrics = class_report.get('Silence', {})
        silence_precision = silence_metrics.get('precision', 0)
        silence_recall = silence_metrics.get('recall', 0)
        silence_f1 = silence_metrics.get('f1-score', 0)

        return {
            'overall_accuracy': overall_accuracy,
            'overall_roc_auc': overall_roc_auc,
            'speech_precision': speech_precision,
            'speech_recall': speech_recall,
            'speech_f1': speech_f1,
            'silence_precision': silence_precision,
            'silence_recall': silence_recall,
            'silence_f1': silence_f1,
            'confusion_matrix': conf_matrix,
            'total_samples': len(all_predictions),
            'speech_ratio_pred': np.mean(all_predictions),
            'speech_ratio_ref': np.mean(all_references),
            'class_report': class_report
        }

    except Exception as e:
        return {'error': f'Error calculating overall metrics: {str(e)}'}


def calculate_vad_metrics(predictions: List[Union[np.ndarray, str]],
                          references: List[np.ndarray],
                          verbose: bool = True) -> Dict:
    """
    Calculate comprehensive VAD evaluation metrics.

    Args:
        predictions (List[Union[np.ndarray, str]]): List of prediction arrays or file paths
        references (List[np.ndarray]): List of reference arrays
        verbose (bool): Whether to print progress information

    Returns:
        dict: Dictionary containing all evaluation metrics
    """
    if verbose:
        print(f"Calculating VAD metrics for {len(predictions)} files...")

    # Process predictions (handle both arrays and file paths)
    processed_predictions = []
    for i, pred in enumerate(predictions):
        if isinstance(pred, str):
            # It's a file path, read the data
            pred_data = read_vad_output_file(pred)
            processed_predictions.append(pred_data)
            if verbose and len(pred_data) > 0:
                print(f"Read {len(pred_data)} VAD frames from {pred}")
        elif isinstance(pred, np.ndarray):
            processed_predictions.append(pred)
        else:
            if verbose:
                print(f"Warning: Invalid prediction format for file {i}")
            processed_predictions.append(np.array([], dtype=np.uint8))

    # Calculate per-file metrics
    per_file_metrics = []
    all_predictions = []
    all_references = []

    min_count = min(len(processed_predictions), len(references))

    for i in range(min_count):
        pred = processed_predictions[i]
        ref = references[i]

        file_metrics = calculate_file_metrics(pred, ref, i)
        per_file_metrics.append(file_metrics)

        if file_metrics.get('valid', False):
            # Align and accumulate for overall metrics
            aligned_pred, aligned_ref = align_sequences(pred, ref)
            if len(aligned_pred) > 0:
                all_predictions.extend(aligned_pred)
                all_references.extend(aligned_ref)

                if verbose:
                    print(f"File {i}: Acc={file_metrics['accuracy']:.4f}, "
                          f"ROC-AUC={file_metrics['roc_auc']:.4f}, "
                          f"Len={file_metrics['length']}, "
                          f"Speech_Pred={file_metrics['speech_ratio_pred']:.3f}, "
                          f"Speech_Ref={file_metrics['speech_ratio_ref']:.3f}")
        else:
            if verbose:
                error_msg = file_metrics.get('error', 'Unknown error')
                print(f"File {i}: Error - {error_msg}")

    # Calculate overall metrics
    if len(all_predictions) == 0:
        if verbose:
            print("Error: No valid predictions to evaluate!")
        return {
            'error': 'No valid predictions to evaluate',
            'per_file_metrics': per_file_metrics,
            'files_processed': 0
        }

    # Convert to numpy arrays for overall calculation
    all_predictions = np.array(all_predictions)
    all_references = np.array(all_references)

    overall_metrics = calculate_overall_metrics(all_predictions, all_references)

    # Calculate per-file statistics
    valid_files = [m for m in per_file_metrics if m.get('valid', False)]
    file_stats = {}

    if valid_files:
        accuracies = [m['accuracy'] for m in valid_files]
        roc_aucs = [m['roc_auc'] for m in valid_files if not np.isnan(m['roc_auc'])]
        speech_f1s = [m['speech_f1'] for m in valid_files]

        file_stats = {
            'accuracy': {
                'mean': np.mean(accuracies),
                'std': np.std(accuracies),
                'min': np.min(accuracies),
                'max': np.max(accuracies)
            },
            'speech_f1': {
                'mean': np.mean(speech_f1s),
                'std': np.std(speech_f1s),
                'min': np.min(speech_f1s),
                'max': np.max(speech_f1s)
            }
        }

        if roc_aucs:
            file_stats['roc_auc'] = {
                'mean': np.mean(roc_aucs),
                'std': np.std(roc_aucs),
                'min': np.min(roc_aucs),
                'max': np.max(roc_aucs)
            }

    # Combine all results
    results = {
        'files_processed': len(valid_files),
        'files_total': min_count,
        'per_file_metrics': per_file_metrics,
        'per_file_stats': file_stats,
        **overall_metrics
    }

    return results
