"""OCRBench_v2 dataset loader for OCR benchmarking."""

import json
from pathlib import Path
from typing import List, Dict, Any, Optional


class OCRBenchLoader:
    """Loader for OCRBench_v2 dataset.

    OCRBench_v2 is a bilingual benchmark with 31 task types.
    This loader focuses on text recognition tasks suitable for pure OCR evaluation.
    """

    # Task types suitable for text extraction benchmarking
    TEXT_RECOGNITION_TASKS = [
        "text recognition en",
        "full-page OCR en",
        "fine-grained text recognition en",
    ]

    # Chinese text recognition tasks (optional)
    TEXT_RECOGNITION_TASKS_CN = [
        "full-page OCR cn",
    ]

    def __init__(self, dataset_path: str):
        """Initialize the dataset loader.

        Args:
            dataset_path: Path to OCRBench_v2 directory
        """
        self.dataset_path = Path(dataset_path).resolve()
        self.data: List[Dict[str, Any]] = []

    def load(self, json_file: Optional[str] = None) -> int:
        """Load the dataset from JSON file.

        Args:
            json_file: Optional specific JSON file path. If None, tries:
                      1. OCRBench_v2.json in dataset root
                      2. Sample predictions in pred_folder

        Returns:
            Number of samples loaded
        """
        if json_file:
            json_path = Path(json_file)
        else:
            # Try main dataset file first
            json_path = self.dataset_path / "OCRBench_v2.json"
            if not json_path.exists():
                # Fall back to sample predictions
                json_path = self.dataset_path / "pred_folder" / "internvl2_5_26b.json"

        if not json_path.exists():
            raise FileNotFoundError(
                f"Dataset JSON not found. Expected at:\n"
                f"  - {self.dataset_path / 'OCRBench_v2.json'}\n"
                f"  - {self.dataset_path / 'pred_folder' / 'internvl2_5_26b.json'}\n"
                f"Please download the dataset from:\n"
                f"  https://drive.google.com/file/d/1Hk1TMu--7nr5vJ7iaNwMQZ_Iw9W_KI3C/view"
            )

        with open(json_path, 'r', encoding='utf-8') as f:
            self.data = json.load(f)

        return len(self.data)

    def filter_by_task_types(self, task_types: List[str]) -> List[Dict[str, Any]]:
        """Filter samples by task type.

        Args:
            task_types: List of task types to include

        Returns:
            Filtered list of samples
        """
        return [
            sample for sample in self.data
            if sample.get("type") in task_types
        ]

    def get_text_recognition_samples(self, include_chinese: bool = False) -> List[Dict[str, Any]]:
        """Get samples suitable for text recognition benchmarking.

        Args:
            include_chinese: Whether to include Chinese text recognition tasks

        Returns:
            List of text recognition samples
        """
        task_types = list(self.TEXT_RECOGNITION_TASKS)
        if include_chinese:
            task_types.extend(self.TEXT_RECOGNITION_TASKS_CN)
        return self.filter_by_task_types(task_types)

    def get_image_path(self, sample: Dict[str, Any]) -> Path:
        """Get full image path for a sample.

        Args:
            sample: Sample dictionary

        Returns:
            Full path to the image file
        """
        relative_path = sample.get("image_path", "")
        return self.dataset_path / relative_path

    def get_ground_truth(self, sample: Dict[str, Any]) -> str:
        """Extract ground truth text from sample answers.

        For OCR tasks, we use the first answer as the primary ground truth.
        Multiple answers typically represent equivalent acceptable outputs.

        Args:
            sample: Sample dictionary

        Returns:
            Ground truth text string
        """
        answers = sample.get("answers", [])

        if isinstance(answers, list):
            if len(answers) > 0:
                return str(answers[0])
            return ""
        else:
            return str(answers)

    def get_all_answers(self, sample: Dict[str, Any]) -> List[str]:
        """Get all acceptable answers for a sample.

        Args:
            sample: Sample dictionary

        Returns:
            List of acceptable answer strings
        """
        answers = sample.get("answers", [])

        if isinstance(answers, list):
            return [str(a) for a in answers]
        else:
            return [str(answers)]

    def get_task_type_counts(self) -> Dict[str, int]:
        """Get count of samples per task type.

        Returns:
            Dictionary mapping task type to count
        """
        counts: Dict[str, int] = {}
        for sample in self.data:
            task_type = sample.get("type", "unknown")
            counts[task_type] = counts.get(task_type, 0) + 1
        return counts

    def validate_images(self, samples: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
        """Validate that images exist for samples.

        Args:
            samples: List of samples to validate

        Returns:
            Dictionary with 'valid' and 'missing' sample lists
        """
        valid = []
        missing = []

        for sample in samples:
            image_path = self.get_image_path(sample)
            if image_path.exists():
                valid.append(sample)
            else:
                missing.append(sample)

        return {"valid": valid, "missing": missing}
