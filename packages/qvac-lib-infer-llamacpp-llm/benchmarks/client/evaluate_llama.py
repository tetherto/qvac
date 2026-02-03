# evaluate_llama.py
from model_handler import ModelHandler, QvacModelHandler, ServerConfig
from results_handler import ResultsHandler
import logging
from datasets import load_dataset
import numpy as np
from tqdm import tqdm
import re
import string
import collections
from transformers import AutoModelForCausalLM, AutoTokenizer
from typing import List, Dict, Any  
import torch
import time
import os
import random
import argparse

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logging.getLogger("transformers").setLevel(logging.ERROR)
logger = logging.getLogger(__name__)

# Set fixed random seed for reproducibility
RANDOM_SEED = 42

class ModelEvaluator:
    def __init__(self, model_name, hf_token: str = None, eval_hf_model: bool = False, server_config: ServerConfig = None):
        if server_config is None:
            self._server_config = ServerConfig(model_name)
        else:
            self._server_config = server_config
        self._eval_hf_model = eval_hf_model
        if eval_hf_model:
            self.model_handler = ModelHandler(model_name, hf_token)
        else:
             self.model_handler = QvacModelHandler(self._server_config)
       
        
        # Set random seeds for reproducibility
        random.seed(RANDOM_SEED)
        np.random.seed(RANDOM_SEED)
        torch.manual_seed(RANDOM_SEED)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(RANDOM_SEED)
            torch.cuda.manual_seed_all(RANDOM_SEED)
        
    def normalize_answer(self, s: str) -> str:
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

    def get_tokens(self, s: str) -> List[str]:
        if not s:
            return []
        return self.normalize_answer(s).split()

    def compute_exact(self, a_gold: str, a_pred: str) -> int:
        return int(self.normalize_answer(a_gold) == self.normalize_answer(a_pred))

    def compute_f1(self, a_gold: str, a_pred: str) -> float:
        gold_toks = self.get_tokens(a_gold)
        pred_toks = self.get_tokens(a_pred)
        common = collections.Counter(gold_toks) & collections.Counter(pred_toks)
        num_same = sum(common.values())
        if len(gold_toks) == 0 or len(pred_toks) == 0:
            return int(gold_toks == pred_toks)
        if num_same == 0:
            return 0
        precision = 1.0 * num_same / len(pred_toks)
        recall = 1.0 * num_same / len(gold_toks)
        f1 = (2 * precision * recall) / (precision + recall)
        return f1

    def evaluate_squad(self, num_samples: int = 100) -> Dict[str, float]:
        """Evaluate model on SQuAD v2.0 benchmark"""
        logger.info("Evaluating SQuAD...")
        dataset = load_dataset("squad_v2", split="validation")
        if num_samples:
            # Use reproducible random sampling
            dataset = dataset.shuffle(seed=RANDOM_SEED).select(range(min(num_samples, len(dataset))))
        
        # Load verification model
        verifier_model = AutoModelForCausalLM.from_pretrained(
            "gpt2",
            torch_dtype=torch.float16 if self.model_handler.device == "cuda" else torch.float32,
            device_map="auto"
        )
        verifier_tokenizer = AutoTokenizer.from_pretrained("gpt2")
        
        exact_scores = []
        f1_scores = []
        total = 0
        
        for item in tqdm(dataset, desc="Evaluating"):
            context = item['context']
            question = item['question']
            
            prompt = f"""Extract the answer to the following question from the given context. If the answer cannot be found in the context, respond with "I cannot answer this question based on the given context." Provide ONLY the answer word or phrase, nothing else. Do not Repeat the question.

Context: {context}

Question: {question}

Answer:"""
            
            answer = self.model_handler.generate_answer(prompt, max_new_tokens=1500)
            if answer.startswith("Extract the answer to the following"):
                answer = answer[min(len(answer), len(prompt)):]

            
            
            if not item['answers']['text']:
                if "cannot answer" in answer.lower():
                    exact_scores.append(1.0)
                    f1_scores.append(1.0)
                else:
                    exact_scores.append(0)
                    f1_scores.append(0)
            else:
                gold_answers = item['answers']['text']
                exact_scores_for_answers = [self.compute_exact(a, answer) for a in gold_answers]
                exact_score = max(exact_scores_for_answers)
                exact_scores.append(exact_score)
                
                f1_scores_for_answers = [self.compute_f1(a, answer) for a in gold_answers]
                f1_score = max(f1_scores_for_answers)
                f1_scores.append(f1_score)
        
            
            total += 1
            
            if total % 10 == 0:
                current_em = 100.0 * np.mean(exact_scores)
                current_f1 = 100.0 * np.mean(f1_scores)
                logger.info(f"\nProgress: {total}/{len(dataset)} questions")
                logger.info(f"Current Exact Match: {current_em:.2f}%")
                logger.info(f"Current F1 Score: {current_f1:.2f}%")
        
        exact_match = 100.0 * np.mean(exact_scores)
        f1 = 100.0 * np.mean(f1_scores)
        
        return {
            "squad_exact_match": exact_match,
            "squad_f1": f1,
            "samples": total
        }

    def evaluate_arc(self, num_samples: int = 100) -> Dict[str, float]:
        """Evaluate model on ARC benchmark"""
        logger.info("Evaluating ARC...")
        dataset = load_dataset("ai2_arc", "ARC-Challenge", split="test")
        if num_samples:
            # Use reproducible random sampling
            dataset = dataset.shuffle(seed=RANDOM_SEED).select(range(min(num_samples, len(dataset))))
        
        correct = 0
        total = 0
        
        for item in tqdm(dataset):
            choices = item['choices']
            prompt = f"Question: {item['question']}\n"
            for i, choice in enumerate(choices['text']):
                prompt += f"{chr(65 + i)}) {choice}\n"
            prompt += "Answer:"
            
            answer = self.model_handler.generate_answer(prompt)
            
            # Try to extract the answer letter from the response
            predicted = None
            if self._eval_hf_model:
                answer = reversed(answer) #TODO olya check why in hf model answer is at the and

            for char in answer:
                if char in ['A', 'B', 'C', 'D']:
                    predicted = char
                    break
            
            if predicted is None:
                continue
            
            correct_answer = item['answerKey']
            
            if predicted == correct_answer:
                correct += 1
            total += 1
            
            # Log progress every 10 questions
            if total % 10 == 0:
                logger.info(f"Processed {total} questions. Current accuracy: {correct/total:.4f}")
        
        accuracy = correct / total if total > 0 else 0
        return {"arc_accuracy": accuracy, "samples": total}

    def evaluate_mmlu(self, num_samples: int = 100) -> Dict[str, float]:
        """Evaluate model on MMLU benchmark"""
        logger.info("Evaluating MMLU...")
        dataset = load_dataset("cais/mmlu", "all", split="test")
        if num_samples:
            # Use reproducible random sampling
            dataset = dataset.shuffle(seed=RANDOM_SEED).select(range(min(num_samples, len(dataset))))
        
        logger.info(f"Evaluating on {len(dataset)} questions")
        correct = 0
        total = 0
        
        for item in tqdm(dataset, desc="Evaluating MMLU"):
            try:
                choices = item['choices']
                prompt = f"""You are taking a multiple choice test. Your task is to select the most accurate answer from the options provided.

Please follow these steps:
1. First, explain your reasoning for each option
2. Then, clearly state your final answer by writing "Final Answer: X" where X is the letter (A, B, C, or D)

Question: {item['question']}

A) {choices[0]}
B) {choices[1]}
C) {choices[2]}
D) {choices[3]}

Your response:"""
                
                # Add timeout to generate_answer call
                answer = self.model_handler.generate_answer(prompt)
                
                # Try to extract the answer letter from the response
                predicted = None
                # First look for "Final Answer: X" format
                final_answer_match = re.search(r'Final Answer:\s*([A-D])', answer, re.IGNORECASE)
                if final_answer_match:
                    predicted = final_answer_match.group(1)
                else:
                    # Fallback to looking for any A, B, C, D in the last line
                    for char in reversed(answer):
                        if char in ['A', 'B', 'C', 'D']:
                            predicted = char
                            break
                
                if predicted is None:
                    logger.warning(f"Could not extract answer from response: {answer}")
                    continue
                
                correct_answer = chr(65 + item['answer'])
                
                if predicted == correct_answer:
                    correct += 1
                total += 1
                
                # Log progress every 10 questions
                if total % 10 == 0:
                    current_accuracy = correct / total if total > 0 else 0
                    logger.info(f"Processed {total} questions. Current accuracy: {current_accuracy:.4f}")
            
            except Exception as e:
                logger.error(f"Error processing question: {e}")
                continue
        
        accuracy = correct / total if total > 0 else 0
        return {"mmlu_accuracy": accuracy, "samples": total}

    def evaluate_gsm8k(self, num_samples: int = 100) -> Dict[str, float]:
        """Evaluate model on GSM8K benchmark"""
        logger.info("Evaluating GSM8K...")
        dataset = load_dataset("gsm8k", "main", split="test")
        if num_samples:
            # Use reproducible random sampling
            dataset = dataset.shuffle(seed=RANDOM_SEED).select(range(min(num_samples, len(dataset))))
        
        correct = 0
        total = 0
        
        for item in tqdm(dataset, desc="Evaluating GSM8K"):
            try:
                prompt = f"""Solve the following math problem step by step. Show your work and clearly state the final answer.
Problem: {item['question']}
Let's solve this step by step:"""
                
                answer = self.model_handler.generate_answer(prompt, max_new_tokens=1000)
                
                # Extract the final answer from the response
                # Look for patterns like "The answer is X" or "Therefore, X" or just a number at the end
                final_answer = None
                
                # Try to find the answer in the last few lines
                lines = answer.strip().split('\n')
                for line in reversed(lines):
                    # Look for common answer patterns
                    answer_patterns = [
                        r'\*\*final answer\*\*\s*.*?the answer is\s*[\$€£]?([\d,]+(?:\.\d+)?)',
                        r'\*\*final answer\*\*\s*.*?([\d,]+(?:\.\d+)?)',
                        r'final answer\s*.*?the answer is\s*[\$€£]?([\d,]+(?:\.\d+)?)',
                        r'final answer\s*.*?([\d,]+(?:\.\d+)?)',
                        r'the answer is\s*[\$€£]?([\d,]+(?:\.\d+)?)',
                        r'therefore\s*[\$€£]?([\d,]+(?:\.\d+)?)',
                        r'answer\s*[\$€£]?([\d,]+(?:\.\d+)?)',
                        r'=\s*[\$€£]?([\d,]+(?:\.\d+)?)',
                        r'([\d,]+(?:\.\d+)?)\s*$',
                        r'.*?([\d,]+(?:\.\d+)?)\s*\.\s*$'
                    ]
                    
                    for pattern in answer_patterns:
                        match = re.search(pattern, line.lower())
                        if match:
                            final_answer = match.group(1)
                            break
                    if final_answer:
                        break
                
                if final_answer is None:
                    logger.warning(f"Could not extract answer from response: {answer}")
                    continue

                print(f" model answer: {final_answer}, correct answer: {item['answer'].split('####')[1].strip()}")
                
                # Compare with the correct answer
                if final_answer == item['answer'].split('####')[1].strip():
                    correct += 1
                total += 1
                
                # Log progress every 10 questions
                if total % 10 == 0:
                    current_accuracy = correct / total if total > 0 else 0
                    logger.info(f"Processed {total} questions. Current accuracy: {current_accuracy:.4f}")
            
            except Exception as e:
                logger.error(f"Error processing question: {e}")
                continue
        
        accuracy = correct / total if total > 0 else 0
        return {"gsm8k_accuracy": accuracy, "samples": total}

def main():
    # Set up argument parser
    parser = argparse.ArgumentParser(
        description="Evaluate LLM models on various benchmarks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Server mode (default) - uses pre-installed models
  python evaluate_llama.py --hf-token YOUR_TOKEN_HERE
  
  # HuggingFace direct mode
  python evaluate_llama.py --hf-token YOUR_TOKEN_HERE --eval-hf-model --model "meta-llama/Llama-3.2-3B-Instruct"
  
  # P2P model mode
  python evaluate_llama.py --hyperdrive-key "hd://b11388de0e9214d8c2181eae30e31bcd49c48b26d621b353ddc7f01972dddd76" --model-name "medgemma-4b-it-Q4_1.gguf"
  
  # P2P model mode with custom config
  python evaluate_llama.py --hyperdrive-key "hd://your-key" --model-name "your-model.gguf"
        """
    )
    
    parser.add_argument(
        "--hf-token",
        help="HuggingFace token for accessing models (required for HuggingFace direct mode)"
    )
    )
    
    parser.add_argument(
        "--model",
        default="meta-llama/Llama-3.2-3B-Instruct",
        help="Model name to evaluate. For HuggingFace models, use full model path (e.g., 'meta-llama/Llama-3.2-3B-Instruct'). For P2P models, this is used as a fallback identifier."
    )
    
    parser.add_argument(
        "--eval-hf-model",
        action="store_true",
        help="Evaluate HuggingFace model directly instead of using server"
    )
    
    parser.add_argument(
        "--hyperdrive-key",
        help="Hyperdrive key for P2P model loading (e.g., hd://b11388de0e9214d8c2181eae30e31bcd49c48b26d621b353ddc7f01972dddd76)"
    )
    
    parser.add_argument(
        "--model-name",
        help="GGUF model filename for P2P models (e.g., medgemma-4b-it-Q4_1.gguf). When provided with --hyperdrive-key, this will be used as the primary model identifier."
    )
    
    parser.add_argument(
        "--config",
        default=None,
        help="Path to config file (default: config.yaml in current directory)"
    )
    
    args = parser.parse_args()
    
    # Validate arguments based on evaluation mode
    if args.eval_hf_model:
        if not args.hf_token or args.hf_token.strip() == "":
            logger.error("HuggingFace token is required when using --eval-hf-model")
            logger.error("You can get your token from: https://huggingface.co/settings/tokens")
            return
    elif args.hyperdrive_key and args.model_name:
        args.model = args.model_name
        # P2P mode - validate required parameters
        if not args.hyperdrive_key.startswith("hd://"):
            logger.error("Hyperdrive key must start with 'hd://'")
            return
    elif not args.hf_token:
        # Server mode - HF token is optional but recommended for some models
        logger.warning("No HuggingFace token provided. Some models may require authentication.")
    
    # Set up config path
    if args.config:
        config_path = args.config
    else:
        # Try to find config.yaml relative to current location
        current_dir = os.getcwd()
        if os.path.basename(current_dir) == 'client':
            config_path = os.path.join(current_dir, 'config.yaml')
        elif os.path.exists(os.path.join(current_dir, 'benchmarks', 'client', 'config.yaml')):
            config_path = os.path.join(current_dir, 'benchmarks', 'client', 'config.yaml')
        else:
            config_path = os.path.join(os.path.dirname(__file__), "config.yaml")
    
    # Remove model config JSON loading logic
    # Create server config with P2P parameters if provided
    server_config = ServerConfig(
        args.model, 
        config_path=config_path,
        hyperdrive_key=args.hyperdrive_key,
        p2p_model_name=args.model_name
    )
    
    # Initialize evaluator and results handler
    try:
        evaluator = ModelEvaluator(args.model, args.hf_token, eval_hf_model=args.eval_hf_model, server_config=server_config)
        
        results_handler = ResultsHandler(args.model, server_config)
    except Exception as e:
        logger.error(f"Failed to initialize evaluator: {e}")
        return
    
    try:
        results_handler.create_results_directory()
        
        # Determine the display model name based on arguments
        if args.hyperdrive_key and args.model_name:
            display_model_name = args.model_name
            logger.info(f"Running evaluations on P2P model: {display_model_name}")
            logger.info(f"Evaluation mode: P2P Model ({args.model_name})")
        elif args.eval_hf_model:
            display_model_name = args.model
            logger.info(f"Running evaluations on HuggingFace model: {display_model_name}")
            logger.info(f"Evaluation mode: HuggingFace Direct")
        else:
            display_model_name = args.model
            logger.info(f"Running evaluations on server model: {display_model_name}")
            logger.info(f"Evaluation mode: Server")
        
        results = {}
        enabled_datasets = server_config.get_enabled_datasets()
        num_samples = server_config.get_num_samples()
        
        logger.info(f"Enabled datasets: {enabled_datasets}")
        logger.info(f"Number of samples per dataset: {num_samples}")
        
        if 'gsm8k' in enabled_datasets:
            results['gsm8k'] = evaluator.evaluate_gsm8k(num_samples=num_samples)
        if 'mmlu' in enabled_datasets:
            results['mmlu'] = evaluator.evaluate_mmlu(num_samples=num_samples)
        if 'squad' in enabled_datasets:
            results['squad'] = evaluator.evaluate_squad(num_samples=num_samples)
        if 'arc' in enabled_datasets:
            results['arc'] = evaluator.evaluate_arc(num_samples=num_samples)

        evaluator.model_handler.close()
        
        md_content = results_handler.format_markdown(
            squad_results=results.get('squad'),
            arc_results=results.get('arc'),
            mmlu_results=results.get('mmlu'),
            gsm8k_results=results.get('gsm8k'),
            device=evaluator.model_handler.device
        )
        
        results_handler.save_results(md_content)
        results_handler.print_results(md_content)
        
    except Exception as e:
        logger.error(f"Error during evaluation: {e}")
        return

if __name__ == "__main__":
    main()