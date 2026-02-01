#!/usr/bin/env python3
"""
Comparative Evaluator for LLM Quality Assessment

This module provides functionality to compare model performance between:
1. @qvac/llm-llamacpp addon (via JS server)
2. Python transformers library (direct HuggingFace)

The evaluator runs the same prompts through both implementations and compares results.
"""

from typing import Any
import logging
import asyncio
import os
from dataclasses import dataclass
from model_handler import ModelHandler, QvacModelHandler, ServerConfig, download_gguf_from_huggingface, ModelEvaluator
from results_handler import ResultsHandler
from utils import get_dataset_configs, DatasetLoader
import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class DatasetComparison:
    """Stores comparison results for a complete dataset"""
    dataset_name: str
    addon_accuracy: float
    transformers_accuracy: float
    sample_count: int
    addon_errors: int = 0
    transformers_errors: int = 0
    metric_name: str = 'accuracy'  # Store which metric was actually calculated
    
    def get_comparison_report(self) -> dict[str, Any]:
        """
        Get a formatted comparison report
        
        Returns:
            Dictionary with addon_metrics and transformers_metrics
        """
        # Only return the metric that was actually calculated for this dataset
        return {
            'addon_metrics': {
                self.metric_name: self.addon_accuracy
            },
            'transformers_metrics': {
                self.metric_name: self.transformers_accuracy
            },
            'total_samples': self.sample_count,
            'addon_errors': self.addon_errors,
            'transformers_errors': self.transformers_errors,
            'metric_name': self.metric_name
        }

class ComparativeEvaluator:
    """
    Evaluates model quality by comparing @qvac/llm-llamacpp addon vs Python transformers
    """
    
    def __init__(self, 
                 addon_model_config: ServerConfig,
                 transformers_model_name: str,
                 hf_token: str,
                 results_handler: ResultsHandler):
        """
        Initialize the comparative evaluator
        
        Args:
            addon_model_config: Configuration for the addon-based model
            transformers_model_name: HuggingFace model name for transformers
            hf_token: HuggingFace authentication token
            results_handler: Handler for storing and formatting results
        """
        self.addon_config = addon_model_config
        self.transformers_model_name = transformers_model_name
        self.hf_token = hf_token
        self.results_handler = results_handler
        
        # Initialize model evaluators
        self.addon_evaluator: ModelEvaluator | None = None
        self.transformers_evaluator: ModelEvaluator | None = None
        
        # Results storage
        self.dataset_comparisons: dict[str, DatasetComparison] = {}
        
    async def initialize_handlers(self):
        """Initialize both model handlers"""
        logger.info("🔧 Initializing model handlers...")
        
        try:
            # Check if we need to download a GGUF model from HuggingFace
            if hasattr(self.addon_config, 'hf_gguf_repo') and self.addon_config.hf_gguf_repo:
                logger.info("📦 HuggingFace GGUF model specified, downloading...")
                
                repo_id = self.addon_config.hf_gguf_repo
                quantization = getattr(self.addon_config, 'hf_gguf_quantization', None)
                
                # Download the GGUF model
                downloaded_path = download_gguf_from_huggingface(
                    repo_id=repo_id,
                    quantization=quantization,
                    hf_token=self.hf_token
                )
                
                # Extract model filename and directory
                model_filename = os.path.basename(downloaded_path)
                models_dir = os.path.dirname(downloaded_path)
                
                logger.info(f"   Using downloaded model: {model_filename}")
                logger.info(f"   Models directory: {models_dir}")
                
                # Update addon_config to use the downloaded model
                # Only set name and diskPath - other config is already in addon_config
                self.addon_config.selected_model = {
                    'name': model_filename,
                    'diskPath': models_dir
                }
                
                logger.info(f"   ✅ Downloaded GGUF model configured for addon")
            
            # Initialize addon evaluator with qvac handler
            logger.info("Initializing @qvac/llm-llamacpp addon handler...")
            addon_device = getattr(self.addon_config, 'device', 'gpu')
            logger.info(f"  Addon device setting: {addon_device}")
            qvac_handler = QvacModelHandler(self.addon_config)
            self.addon_evaluator = ModelEvaluator(qvac_handler, "addon")
            logger.info("✅ Addon evaluator initialized successfully")
            
            # Initialize transformers evaluator
            logger.info(f"Initializing transformers handler for {self.transformers_model_name}...")
            device = getattr(self.addon_config, 'device', 'gpu')
            logger.info(f"  Passing device to Transformers: {device}")
            
            # Add transformers-specific attributes to config
            self.addon_config.transformers_model_name = self.transformers_model_name
            self.addon_config.hf_token = self.hf_token
            
            transformers_handler = ModelHandler(self.addon_config)
            self.transformers_evaluator = ModelEvaluator(transformers_handler, "transformers")
            logger.info("✅ Transformers evaluator initialized successfully")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize handlers: {e}")
            raise
    
    async def cleanup_handlers(self):
        """Clean up model handlers"""
        logger.info("🧹 Cleaning up model handlers...")
        
        if self.addon_evaluator:
            try:
                self.addon_evaluator.handler.close()
                logger.info("✅ Addon handler closed")
            except Exception as e:
                logger.warning(f"Warning during addon handler cleanup: {e}")
        
        if self.transformers_evaluator:
            try:
                self.transformers_evaluator.handler.close()
                logger.info("✅ Transformers handler closed")
            except Exception as e:
                logger.warning(f"Warning during transformers handler cleanup: {e}")
    
    async def evaluate_dataset(self, 
                              dataset_name: str, 
                              prompts: list[str], 
                              ground_truths: list[str],
                              metric_fn,
                              metric_name: str = 'accuracy',
                              system_prompt: str = None) -> DatasetComparison:
        """
        Evaluate both implementations on a complete dataset using ModelEvaluators.
        
        Args:
            dataset_name: Name of the dataset being evaluated
            prompts: List of input prompts
            ground_truths: List of correct answers
            metric_fn: Function to calculate accuracy metrics
            metric_name: Name of the metric being calculated (e.g., 'accuracy', 'f1')
            system_prompt: Optional system prompt to guide model behavior (applied to both handlers)
            
        Returns:
            DatasetComparison containing comprehensive comparison results
        """
        logger.info(f"📊 Evaluating dataset: {dataset_name} ({len(prompts)} samples)")
        
        if len(prompts) == 0:
            logger.warning(f"⚠️  No prompts provided for {dataset_name}!")
        
        # Evaluate addon using ModelEvaluator
        logger.info(f"🔍 Running addon evaluation for {dataset_name}...")
        addon_scores, addon_errors = self.addon_evaluator.evaluate_dataset(
            dataset_name, prompts, ground_truths, metric_fn, system_prompt
        )
        
        # Evaluate transformers using ModelEvaluator
        logger.info(f"🔍 Running transformers evaluation for {dataset_name}...")
        transformers_scores, transformers_errors = self.transformers_evaluator.evaluate_dataset(
            dataset_name, prompts, ground_truths, metric_fn, system_prompt
        )
        
        # Calculate accuracies
        addon_accuracy = np.mean(addon_scores) if addon_scores else 0.0
        transformers_accuracy = np.mean(transformers_scores) if transformers_scores else 0.0
        
        logger.info(f"📊 Addon scores: mean={addon_accuracy:.4f}, samples={len(addon_scores)}, errors={addon_errors}")
        logger.info(f"📊 Transformers scores: mean={transformers_accuracy:.4f}, samples={len(transformers_scores)}, errors={transformers_errors}")
        
        comparison = DatasetComparison(
            dataset_name=dataset_name,
            addon_accuracy=addon_accuracy,
            transformers_accuracy=transformers_accuracy,
            sample_count=len(prompts),
            addon_errors=addon_errors,
            transformers_errors=transformers_errors,
            metric_name=metric_name
        )
        
        # Store results
        self.dataset_comparisons[dataset_name] = comparison
        
        logger.info(f"✅ {dataset_name} evaluation completed:")
        logger.info(f"   Addon accuracy: {addon_accuracy:.2%}")
        logger.info(f"   Transformers accuracy: {transformers_accuracy:.2%}")
        
        return comparison
    
    def get_addon_model_name(self) -> str:
        """
        Get the addon model name from server configuration
        
        Returns:
            String representation of the addon model name for display purposes
        """
        # Use full CLI specification for model name
        if hasattr(self.addon_config, 'hf_gguf_repo') and self.addon_config.hf_gguf_repo:
            # HuggingFace GGUF model - use full repo:quantization format
            addon_model_name = self.addon_config.hf_gguf_repo
            if hasattr(self.addon_config, 'hf_gguf_quantization') and self.addon_config.hf_gguf_quantization:
                addon_model_name = f"{self.addon_config.hf_gguf_repo}:{self.addon_config.hf_gguf_quantization}"
        elif hasattr(self.addon_config, 'hyperdrive_uri') and self.addon_config.hyperdrive_uri:
            # Hyperdrive model - use full URI
            addon_model_name = self.addon_config.hyperdrive_uri
        elif hasattr(self.addon_config, 'selected_model') and self.addon_config.selected_model:
            # Use selected_model name if available
            addon_model_name = self.addon_config.selected_model.get('name', 'addon_model')
        elif hasattr(self.addon_config, 'p2p_model_name') and self.addon_config.p2p_model_name:
            # Use P2P model name
            addon_model_name = self.addon_config.p2p_model_name
        else:
            addon_model_name = "addon_model"
        
        return addon_model_name
    
    def save_and_print_results(self):
        """
        Save comparative evaluation results to file and print summary to terminal
        """
        # Get model names for results
        addon_model_name = self.get_addon_model_name()
        transformers_model_name = self.transformers_model_name
        
        # Format comparative results into markdown
        md_content = self.results_handler.format_comparative_markdown(
            addon_name=addon_model_name,
            transformers_name=transformers_model_name,
            dataset_comparisons=self.dataset_comparisons
        )
        
        # Save results to file
        self.results_handler.save_results(md_content)
        
        # Print results to terminal
        print("\n" + "="*80)
        print("📊 COMPARATIVE EVALUATION RESULTS")
        print("="*80)
        
        # Print concise summary to terminal (more readable than full markdown)
        for dataset_name, comparison in self.dataset_comparisons.items():
            print(f"\n📈 {dataset_name.upper()}")
            print("-" * 50)
            
            # Get metric name and display it correctly
            report = comparison.get_comparison_report()
            metric_name = report.get('metric_name', 'accuracy')
            
            # Map metric names to display labels
            metric_labels = {
                'f1': 'F1 Score',
                'accuracy': 'Accuracy'
            }
            metric_label = metric_labels.get(metric_name, metric_name.title())
            
            print(f"   Addon (@qvac/llm-llamacpp) {metric_label}:  {comparison.addon_accuracy:.2%}")
            print(f"   Transformers (HuggingFace) {metric_label}:  {comparison.transformers_accuracy:.2%}")
        
        # Print configuration used
        print("\n⚙️  MODEL CONFIGURATION")
        print("-" * 80)
        print(f"   • Temperature: {self.addon_config.temp}")
        print(f"   • Top-P: {self.addon_config.top_p}")
        print(f"   • Top-K: {self.addon_config.top_k}")
        print(f"   • Max Tokens: {self.addon_config.n_predict}")
        print(f"   • Context Size: {self.addon_config.ctx_size}")
        print(f"   • GPU Layers: {self.addon_config.gpu_layers}")
        print(f"   • Device: {self.addon_config.device}")
        print(f"   • Repeat Penalty: {self.addon_config.repeat_penalty}")
        print(f"   • Seed: {self.addon_config.seed}")
        
        print("\n" + "="*80)
        print(f"📄 Full results saved to: {self.results_handler.results_dir}")
        print("="*80)
        logger.info("✅ Comparative evaluation completed!")
    
    async def run_evaluation(self):
        """
        Complete comparative evaluation workflow: load datasets, evaluate, and save results
        
        This method orchestrates the entire evaluation process using the server_config
        passed during initialization.
        """
        logger.info("🚀 Starting comparative evaluation...")
        
        # Get evaluation configuration
        enabled_datasets = self.addon_config.get_enabled_datasets()
        num_samples = self.addon_config.get_num_samples()
        
        logger.info(f"Enabled datasets: {enabled_datasets}")
        logger.info(f"Number of samples per dataset: {num_samples}")
        
        # Prepare datasets configuration
        datasets_config = {}
        
        # Load and prepare datasets
        if 'squad' in enabled_datasets:
            logger.info("📚 Loading SQuAD dataset...")
            prompts, ground_truths, config = DatasetLoader.load_squad(num_samples)
            logger.info(f"✅ SQuAD prepared: {len(prompts)} prompts, {len(ground_truths)} ground truths")
            datasets_config['squad'] = {
                'prompts': prompts,
                'ground_truths': ground_truths,
                'metric_fn': config['metric_fn'],
                'metric_name': config['metric_name'],
                'system_prompt': config['system_prompt']
            }
        
        if 'arc' in enabled_datasets:
            logger.info("📚 Loading ARC dataset...")
            prompts, ground_truths, config = DatasetLoader.load_arc(num_samples)
            logger.info(f"✅ ARC prepared: {len(prompts)} prompts, {len(ground_truths)} ground truths")
            datasets_config['arc'] = {
                'prompts': prompts,
                'ground_truths': ground_truths,
                'metric_fn': config['metric_fn'],
                'metric_name': config['metric_name'],
                'system_prompt': config['system_prompt']
            }
        
        if 'mmlu' in enabled_datasets:
            logger.info("📚 Loading MMLU dataset...")
            prompts, ground_truths, config = DatasetLoader.load_mmlu(num_samples)
            logger.info(f"✅ MMLU prepared: {len(prompts)} prompts, {len(ground_truths)} ground truths")
            datasets_config['mmlu'] = {
                'prompts': prompts,
                'ground_truths': ground_truths,
                'metric_fn': config['metric_fn'],
                'metric_name': config['metric_name'],
                'system_prompt': config['system_prompt']
            }
        
        if 'gsm8k' in enabled_datasets:
            logger.info("📚 Loading GSM8K dataset...")
            prompts, ground_truths, config = DatasetLoader.load_gsm8k(num_samples)
            logger.info(f"✅ GSM8K prepared: {len(prompts)} prompts, {len(ground_truths)} ground truths")
            datasets_config['gsm8k'] = {
                'prompts': prompts,
                'ground_truths': ground_truths,
                'metric_fn': config['metric_fn'],
                'metric_name': config['metric_name'],
                'system_prompt': config['system_prompt']
            }
        
        # Log prepared datasets
        logger.info(f"🔍 Datasets prepared: {list(datasets_config.keys())}")
        for ds_name, ds_config in datasets_config.items():
            logger.info(f"  {ds_name}: {len(ds_config['prompts'])} prompts")
        
        # Run full comparison
        logger.info("🚀 Starting full comparative evaluation...")
        logger.info(f"📦 Evaluating {len(datasets_config)} dataset(s): {', '.join(datasets_config.keys())}")
        
        try:
            # Initialize handlers
            await self.initialize_handlers()
            
            # Run evaluations for each dataset
            for dataset_name, config in datasets_config.items():
                try:
                    await self.evaluate_dataset(
                        dataset_name=dataset_name,
                        prompts=config["prompts"],
                        ground_truths=config["ground_truths"],
                        metric_fn=config["metric_fn"],
                        metric_name=config.get("metric_name", "accuracy"),
                        system_prompt=config.get("system_prompt", None)
                    )
                except Exception as e:
                    logger.error(f"❌ Error evaluating {dataset_name}: {e}")
                    import traceback
                    traceback.print_exc()
            
            logger.info("✅ Full comparative evaluation completed!")
            
            # Check for errors across all datasets
            datasets_with_errors = []
            for dataset_name, comparison in self.dataset_comparisons.items():
                if comparison.addon_errors > 0 or comparison.transformers_errors > 0:
                    datasets_with_errors.append((dataset_name, comparison.addon_errors, comparison.transformers_errors))
            
            # If any errors occurred, fail the benchmark
            if datasets_with_errors:
                print("\n" + "="*80)
                print("❌ COMPARATIVE BENCHMARK FAILED - ERRORS DETECTED")
                print("="*80)
                for dataset_name, addon_errs, trans_errs in datasets_with_errors:
                    if addon_errs > 0:
                        print(f"   • {dataset_name.upper()} - Addon: {addon_errs} error(s)")
                    if trans_errs > 0:
                        print(f"   • {dataset_name.upper()} - Transformers: {trans_errs} error(s)")
                print("="*80)
                logger.error("Comparative benchmark failed due to errors in one or more datasets")
                raise RuntimeError("Benchmark failed with errors")
            
            # Save and print results
            self.save_and_print_results()
            
        finally:
            # Always clean up handlers
            await self.cleanup_handlers()
