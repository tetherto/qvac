"""
Utility functions for benchmark evaluation
"""

import re
import string
import collections
from datasets import load_dataset

# Fixed random seed for reproducibility
RANDOM_SEED = 42


def normalize_answer(s: str) -> str:
    """Lower text and remove punctuation, articles and extra whitespace."""
    def remove_articles(text):
        regex = re.compile(r'\b(a|an|the)\b', re.UNICODE)
        return re.sub(regex, ' ', text)
    def white_space_fix(text):
        return ' '.join(text.split())
    def remove_punc(text):
        exclude = set(string.punctuation)
        return ''.join(ch for ch in text if ch not in exclude)
    def lower(text):
        return text.lower()
    return white_space_fix(remove_articles(remove_punc(lower(s))))


def get_tokens(s: str) -> list[str]:
    """Get normalized tokens from string"""
    if not s:
        return []
    return normalize_answer(s).split()


def compute_f1(a_gold: str, a_pred: str) -> float:
    """Compute F1 score between gold and predicted answers"""
    gold_toks = get_tokens(a_gold)
    pred_toks = get_tokens(a_pred)
    common = collections.Counter(gold_toks) & collections.Counter(pred_toks)
    num_same = sum(common.values())
    if len(gold_toks) == 0 or len(pred_toks) == 0:
        return int(gold_toks == pred_toks)
    if num_same == 0:
        return 0.0
    precision = 1.0 * num_same / len(pred_toks)
    recall = 1.0 * num_same / len(gold_toks)
    f1 = (2 * precision * recall) / (precision + recall)
    return f1


def get_dataset_extractors():
    """
    Get dataset-specific extraction functions.
    These are shared between ModelEvaluator and comparative evaluation.
    """
    def extract_arc_answer(text):
        """Extract answer from ARC format: 'Answer: X' where X is A, B, C, or D"""
        match = re.search(r'Answer:\s*([ABCD])', text, re.IGNORECASE)
        if match:
            return match.group(1).upper()
        match = re.search(r'\b([ABCD])\b', text.upper())
        return match.group(1) if match else ""
    
    def extract_mmlu_answer(text):
        """Extract answer from MMLU format: 'Answer: X' where X is A, B, C, or D"""
        match = re.search(r'Answer:\s*([ABCD])', text, re.IGNORECASE)
        if match:
            return match.group(1).upper()
        match = re.search(r'\b([ABCD])\b', text.upper())
        return match.group(1) if match else ""
    
    def extract_gsm8k_answer(text):
        """Extract numerical answer from GSM8K format: 'Final answer: NUMBER'"""
        match = re.search(r'Final answer:\s*(-?\d+(?:\.\d+)?)', text, re.IGNORECASE)
        if match:
            return match.group(1)
        numbers = re.findall(r'-?\d+(?:\.\d+)?', text)
        return numbers[-1] if numbers else None
    
    return {
        'arc': extract_arc_answer,
        'mmlu': extract_mmlu_answer,
        'gsm8k': extract_gsm8k_answer
    }


def get_dataset_configs():
    """
    Get standardized dataset configurations including prompts, system prompts, and metrics.
    This ensures consistency between ModelEvaluator and comparative evaluation.
    """
    extractors = get_dataset_extractors()
    
    # Helper metric functions that wrap module-level functions
    def exact_match_simple(prediction, ground_truth):
        """Simple exact match (case-insensitive, whitespace-normalized) for multiple choice"""
        return 1.0 if prediction.strip().lower() == ground_truth.strip().lower() else 0.0
    
    def f1_score_with_unanswerable(prediction, ground_truth):
        """F1 score for SQuAD with unanswerable question handling"""
        # Handle unanswerable questions (SQuAD v2.0)
        if not ground_truth or ground_truth.strip() == "":
            # Ground truth is unanswerable
            if "cannot answer" in prediction.lower():
                return 1.0  # Correct - model said can't answer
            else:
                return 0.0  # Wrong - model gave an answer when it shouldn't
        
        # Normal answerable question - use module-level compute_f1
        return compute_f1(ground_truth, prediction)
    
    def gsm8k_accuracy(prediction, ground_truth):
        """Calculate accuracy for GSM8K using extracted answers"""
        pred_answer = extractors['gsm8k'](prediction)
        truth_numbers = re.findall(r'-?\d+(?:\.\d+)?', ground_truth)
        truth_answer = truth_numbers[-1] if truth_numbers else None
        
        if pred_answer and truth_answer:
            try:
                return 1.0 if float(pred_answer) == float(truth_answer) else 0.0
            except ValueError:
                pass
        return 0.0
    
    return {
        'squad': {
            'system_prompt': 'You are an AI assistant. Extract the answer from the context if it exists. If the answer cannot be found in the context, respond with: "Cannot answer from context."',
            'prompt_template': lambda context, question: f"Context: {context}\n\nQuestion: {question}\n",
            'metric_fn': f1_score_with_unanswerable,
            'metric_name': 'f1',
            'extractor': None  # SQuAD uses direct comparison
        },
        'arc': {
            'system_prompt': 'You are a helpful assistant. Select the best answer and respond with: "Answer: X" where X is A, B, C, or D.',
            'prompt_template': lambda question, choices: f"Question: {question}\n" + "\n".join([f"{choices['label'][i]}) {choices['text'][i]}" for i in range(len(choices['text']))]) + "\n",
            'metric_fn': lambda pred, truth: exact_match_simple(extractors['arc'](pred), truth),
            'metric_name': 'accuracy',
            'extractor': extractors['arc']
        },
        'mmlu': {
            'system_prompt': 'You are a helpful assistant. Select the best answer and respond with: "Answer: X" where X is A, B, C, or D.',
            'prompt_template': lambda question, choices: f"Question: {question}\n\n" + "\n".join([f"{chr(65+i)}) {choice}" for i, choice in enumerate(choices)]) + "\n",
            'metric_fn': lambda pred, truth: exact_match_simple(extractors['mmlu'](pred), truth),
            'metric_name': 'accuracy',
            'extractor': extractors['mmlu']
        },
        'gsm8k': {
            'system_prompt': 'You are a math problem solver. Show your work step by step. End with "Final answer:" followed by only the number.',
            'prompt_template': lambda question: f"Question: {question}",
            'metric_fn': gsm8k_accuracy,
            'metric_name': 'accuracy',
            'extractor': extractors['gsm8k']
        }
    }


class DatasetLoader:
    """Handles loading and preparing datasets for evaluation"""
    
    @staticmethod
    def load_squad(num_samples: int) -> tuple[list[str], list[str], dict]:
        """
        Load and prepare SQuAD dataset
        
        Returns:
            Tuple of (prompts, ground_truths, config)
        """
        config = get_dataset_configs()['squad']
        dataset = load_dataset("squad_v2", split="validation")
        if num_samples:
            dataset = dataset.shuffle(seed=RANDOM_SEED).select(range(min(num_samples, len(dataset))))
        
        prompts = []
        ground_truths = []
        
        for sample in dataset:
            prompt = config['prompt_template'](sample['context'], sample['question'])
            prompts.append(prompt)
            
            # Use first answer if available, otherwise empty string for unanswerable
            answer = sample['answers']['text'][0] if sample['answers']['text'] else ""
            ground_truths.append(answer)
        
        return prompts, ground_truths, config
    
    @staticmethod
    def load_arc(num_samples: int) -> tuple[list[str], list[str], dict]:
        """
        Load and prepare ARC dataset
        
        Returns:
            Tuple of (prompts, ground_truths, config)
        """
        config = get_dataset_configs()['arc']
        dataset = load_dataset("allenai/ai2_arc", "ARC-Challenge", split="test")
        if num_samples:
            dataset = dataset.shuffle(seed=RANDOM_SEED).select(range(min(num_samples, len(dataset))))
        
        prompts = []
        ground_truths = []
        
        for sample in dataset:
            prompt = config['prompt_template'](sample['question'], sample['choices'])
            prompts.append(prompt)
            ground_truths.append(sample['answerKey'])
        
        return prompts, ground_truths, config
    
    @staticmethod
    def load_mmlu(num_samples: int) -> tuple[list[str], list[str], dict]:
        """
        Load and prepare MMLU dataset
        
        Returns:
            Tuple of (prompts, ground_truths, config)
        """
        config = get_dataset_configs()['mmlu']
        dataset = load_dataset("cais/mmlu", "all", split="test")
        if num_samples:
            dataset = dataset.shuffle(seed=RANDOM_SEED).select(range(min(num_samples, len(dataset))))
        
        prompts = []
        ground_truths = []
        
        for sample in dataset:
            prompt = config['prompt_template'](sample['question'], sample['choices'])
            prompts.append(prompt)
            ground_truths.append(chr(65 + sample['answer']))  # Convert 0,1,2,3 to A,B,C,D
        
        return prompts, ground_truths, config
    
    @staticmethod
    def load_gsm8k(num_samples: int) -> tuple[list[str], list[str], dict]:
        """
        Load and prepare GSM8K dataset
        
        Returns:
            Tuple of (prompts, ground_truths, config)
        """
        config = get_dataset_configs()['gsm8k']
        dataset = load_dataset("gsm8k", "main", split="test")
        if num_samples:
            dataset = dataset.shuffle(seed=RANDOM_SEED).select(range(min(num_samples, len(dataset))))
        
        prompts = []
        ground_truths = []
        
        for sample in dataset:
            prompt = config['prompt_template'](sample['question'])
            prompts.append(prompt)
            ground_truths.append(sample['answer'])
        
        return prompts, ground_truths, config

