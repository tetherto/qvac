# comparative_evaluator.py - Comparative evaluation for embeddings models

import logging
import asyncio
import os
import mteb
import numpy as np
from dataclasses import dataclass

from model_handler import (
    QvacEmbedHandler,
    SentenceTransformersHandler,
    MTEBModelWrapper,
    ServerConfig,
    resolve_dtypes
)
from results_handler import ResultsHandler
from utils import load_mteb_tasks, AVAILABLE_DATASETS

logger = logging.getLogger(__name__)


@dataclass
class DatasetComparison:
    """Stores comparison results for a dataset"""
    dataset_name: str
    addon_results: dict[str, float]
    transformers_results: dict[str, float]
    
    def get_comparison_dict(self) -> dict[str, float]:
        """Get flattened comparison dictionary"""
        result = {'dataset': self.dataset_name}
        
        for key, value in self.addon_results.items():
            result[f'addon_{key}'] = value
        
        for key, value in self.transformers_results.items():
            result[f'transformers_{key}'] = value
        
        return result


class ComparativeEvaluator:
    """
    Evaluates embeddings quality by comparing @qvac/embed-llamacpp addon
    vs SentenceTransformers
    """
    
    def __init__(self,
                 addon_config: ServerConfig,
                 transformers_model_name: str,
                 results_handler: ResultsHandler,
                 gguf_model_name: str = None):
        """
        Initialize the comparative evaluator.
        
        Args:
            addon_config: Configuration for the addon-based model
            transformers_model_name: HuggingFace model name for SentenceTransformers
            results_handler: Handler for storing and formatting results
            gguf_model_name: Original GGUF model name (for dtype matching)
        """
        self.addon_config = addon_config
        self.results_handler = results_handler
        self.gguf_model_name = gguf_model_name
        
        # Extract GGUF quantization from model name (e.g., "repo:F16" -> "F16")
        self.gguf_quantization = None
        if gguf_model_name and ":" in gguf_model_name:
            suffix = gguf_model_name.rsplit(":", 1)[1].upper()
            # Check if it's a valid quantization/dtype suffix
            if suffix in ("F16", "FP16", "F32", "FP32", "BF16", "Q8_0", "Q4_K_M", "Q4_0", "Q5_K_M", "Q6_K"):
                self.gguf_quantization = suffix
        
        # Resolve dtypes for fair comparison
        # If one specifies dtype (e.g., :F16), the other auto-matches
        gguf_for_dtype = gguf_model_name or ""
        _, clean_transformers, effective_dtype = resolve_dtypes(
            gguf_for_dtype, 
            transformers_model_name, 
            addon_config.device
        )
        
        self.transformers_model_name = clean_transformers
        self.effective_dtype = effective_dtype
        logger.info(f"Comparative evaluation will use dtype: {effective_dtype}")
        
        # Handlers will be initialized later
        self.addon_handler: QvacEmbedHandler | None = None
        self.transformers_handler: SentenceTransformersHandler | None = None
        
        # Results storage
        self.dataset_comparisons: dict[str, DatasetComparison] = {}
    
    async def initialize_handlers(self):
        """Initialize both model handlers"""
        logger.info("Initializing model handlers...")
        
        try:
            # Initialize addon handler
            logger.info("Initializing @qvac/embed-llamacpp addon handler...")
            self.addon_handler = QvacEmbedHandler(self.addon_config)
            
            # For P2P models, wait for the model to be fully downloaded from Hyperdrive
            self.addon_handler.wait_for_model_ready()
            logger.info("Addon handler initialized successfully")
            
            # Initialize SentenceTransformers handler with resolved dtype
            logger.info(f"Initializing SentenceTransformers handler for {self.transformers_model_name}...")
            logger.info(f"  Using dtype: {self.effective_dtype}")
            device = self.addon_config.device
            self.transformers_handler = SentenceTransformersHandler(
                self.transformers_model_name,
                device=device,
                dtype=self.effective_dtype
            )
            logger.info("SentenceTransformers handler initialized successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize handlers: {e}")
            raise
    
    async def cleanup_handlers(self):
        """Clean up model handlers"""
        logger.info("Cleaning up model handlers...")
        
        if self.addon_handler:
            try:
                self.addon_handler.close()
                logger.info("Addon handler closed")
            except Exception as e:
                logger.warning(f"Warning during addon handler cleanup: {e}")
        
        if self.transformers_handler:
            try:
                self.transformers_handler.close()
                logger.info("SentenceTransformers handler closed")
            except Exception as e:
                logger.warning(f"Warning during transformers handler cleanup: {e}")
    
    def _run_mteb_evaluation(self, model_wrapper: MTEBModelWrapper,
                            dataset_names: list[str],
                            prediction_folder: str | None = None) -> dict[str, dict[str, float]]:
        """
        Run MTEB evaluation for a single model using mteb.evaluate().
        
        Args:
            model_wrapper: MTEB-compatible model wrapper
            dataset_names: List of datasets to evaluate
            prediction_folder: Optional folder to save raw MTEB results
            
        Returns:
            Dictionary mapping dataset name to metrics
        """
        num_samples = self.addon_config.get_num_samples()
        tasks = load_mteb_tasks(dataset_names, num_samples=num_samples)
        
        http_batch_size = self.addon_config.get_http_batch_size()
        
        model_result = mteb.evaluate(
            model=model_wrapper,
            tasks=tasks,
            encode_kwargs={"batch_size": http_batch_size},
            raise_error=True,
            show_progress_bar=True,
            cache=None,  # Disable MTEB cache - wrapper model name doesn't reflect actual config
            prediction_folder=prediction_folder
        )
        
        # Parse results from ModelResult into metrics dictionary
        parsed_results = {}
        for task_result in model_result.task_results:
            dataset_name = task_result.task_name
            
            # Get test scores
            test_scores = task_result.scores.get('test', [])
            if test_scores and len(test_scores) > 0:
                scores = test_scores[0]
                parsed_results[dataset_name] = {
                    'ndcg_at_10': scores.get('ndcg_at_10', 0),
                    'mrr_at_10': scores.get('mrr_at_10', 0),
                    'recall_at_10': scores.get('recall_at_10', 0),
                    'precision_at_10': scores.get('precision_at_10', 0)
                }
        
        return parsed_results
    
    async def evaluate_dataset(self, dataset_name: str) -> DatasetComparison:
        """
        Evaluate both implementations on a single dataset.
        
        Args:
            dataset_name: Name of the MTEB dataset
            
        Returns:
            DatasetComparison with results from both models
        """
        logger.info(f"Evaluating dataset: {dataset_name}")
        
        # Get raw results folder for saving MTEB predictions
        raw_results_base = self.results_handler.get_raw_results_path()
        
        # Evaluate addon
        logger.info(f"Running addon evaluation for {dataset_name}...")
        addon_wrapper = MTEBModelWrapper(
            self.addon_handler,
            batch_size=self.addon_config.get_http_batch_size(),
            max_seq_length=int(self.addon_config.ctx_size)
        )
        addon_raw_folder = os.path.join(raw_results_base, "addon")
        addon_results = self._run_mteb_evaluation(addon_wrapper, [dataset_name], addon_raw_folder)
        
        # Evaluate transformers
        logger.info(f"Running transformers evaluation for {dataset_name}...")
        transformers_wrapper = MTEBModelWrapper(
            self.transformers_handler,
            batch_size=self.addon_config.get_http_batch_size(),
            max_seq_length=int(self.addon_config.ctx_size)
        )
        transformers_raw_folder = os.path.join(raw_results_base, "transformers")
        transformers_results = self._run_mteb_evaluation(transformers_wrapper, [dataset_name], transformers_raw_folder)
        
        # Create comparison
        comparison = DatasetComparison(
            dataset_name=dataset_name,
            addon_results=addon_results.get(dataset_name, {}),
            transformers_results=transformers_results.get(dataset_name, {})
        )
        
        self.dataset_comparisons[dataset_name] = comparison
        
        logger.info(f"Completed evaluation for {dataset_name}")
        logger.info(f"  Addon nDCG@10: {comparison.addon_results.get('ndcg_at_10', 0)*100:.2f}%")
        logger.info(f"  Transformers nDCG@10: {comparison.transformers_results.get('ndcg_at_10', 0)*100:.2f}%")
        
        return comparison
    
    def get_addon_model_name(self) -> str:
        """Get the addon model name from configuration"""
        # Check P2P model first
        if hasattr(self.addon_config, 'p2p_model_name') and self.addon_config.p2p_model_name:
            return self.addon_config.p2p_model_name.replace('.gguf', '')
        # Then check selected_model (HuggingFace download)
        if hasattr(self.addon_config, 'selected_model') and self.addon_config.selected_model:
            name = self.addon_config.selected_model.get('name', '')
            return name.replace('.gguf', '') if name else ''
        raise ValueError("No addon model name found in configuration")
    
    def save_and_print_results(self):
        """Save comparative evaluation results and print summary"""
        addon_model_name = self.get_addon_model_name()
        
        # Prepare comparison data for results handler
        comparison_data = {}
        for dataset_name, comparison in self.dataset_comparisons.items():
            comp_dict = comparison.get_comparison_dict()
            comparison_data[dataset_name] = comp_dict
        
        # Get transformers dtype if available
        transformers_dtype = None
        if hasattr(self, 'transformers_handler') and hasattr(self.transformers_handler, 'dtype_str'):
            transformers_dtype = self.transformers_handler.dtype_str
        
        # Get addon quantization
        addon_quantization = getattr(self, 'gguf_quantization', None)
        
        # Format and save results
        md_content = self.results_handler.format_comparative_markdown(
            addon_name=addon_model_name,
            transformers_name=self.transformers_model_name,
            dataset_comparisons=comparison_data,
            transformers_dtype=transformers_dtype,
            addon_quantization=addon_quantization
        )
        
        self.results_handler.save_results(md_content)
        
        # Print summary
        print("\n" + "=" * 80)
        print("COMPARATIVE EVALUATION RESULTS")
        print("=" * 80)
        
        for dataset_name, comparison in self.dataset_comparisons.items():
            print(f"\n{dataset_name}")
            print("-" * 50)
            print(f"  Addon nDCG@10:       {comparison.addon_results.get('ndcg_at_10', 0)*100:.2f}%")
            print(f"  Transformers nDCG@10: {comparison.transformers_results.get('ndcg_at_10', 0)*100:.2f}%")
        
        # Print configuration
        print("\n" + "-" * 80)
        print("Configuration:")
        print(f"  Device: {self.addon_config.device}")
        print(f"  GPU Layers: {self.addon_config.gpu_layers}")
        print(f"  Context Size: {self.addon_config.ctx_size} tokens")
        print(f"  Batch Size: {self.addon_config.batch_size} tokens")
        print(f"  HTTP Batch: {self.addon_config.get_http_batch_size()} sentences/request")
        
        # Show addon quantization
        if hasattr(self, 'gguf_quantization') and self.gguf_quantization:
            print(f"  Addon quantization: {self.gguf_quantization}")
        
        # Show transformers dtype if available
        if hasattr(self, 'transformers_handler') and hasattr(self.transformers_handler, 'dtype_str'):
            print(f"  Transformers dtype: {self.transformers_handler.dtype_str}")
        
        print("\n" + "=" * 80)
        print(f"Full results saved to: {self.results_handler.results_dir}")
        print("=" * 80)
    
    async def run_evaluation(self):
        """
        Complete comparative evaluation workflow.
        """
        logger.info("Starting comparative evaluation...")
        
        enabled_datasets = self.addon_config.get_enabled_datasets()
        logger.info(f"Enabled datasets: {enabled_datasets}")
        
        try:
            # Initialize handlers
            await self.initialize_handlers()
            
            # Evaluate each dataset
            for dataset_name in enabled_datasets:
                try:
                    await self.evaluate_dataset(dataset_name)
                except Exception as e:
                    logger.error(f"Error evaluating {dataset_name}: {e}")
                    import traceback
                    traceback.print_exc()
            
            logger.info("Comparative evaluation completed!")
            
            # Save and print results
            self.save_and_print_results()
            
        finally:
            # Always clean up handlers
            await self.cleanup_handlers()
