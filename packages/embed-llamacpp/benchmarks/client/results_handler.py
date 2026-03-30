# results_handler.py - Results formatting and output for embeddings benchmark

from typing import Any
import os
import json
import logging
from datetime import datetime
from model_handler import ServerConfig

logger = logging.getLogger(__name__)


class ResultsHandler:
    """Handles formatting and saving benchmark results"""
    
    def __init__(self, model_name: str, server_config: ServerConfig):
        """
        Initialize results handler.
        
        Args:
            model_name: Name of the model being benchmarked
            server_config: Server configuration object
        """
        # Check if this is a comparative evaluation
        is_comparative = "_vs_" in model_name
        
        if is_comparative:
            self.model_name = model_name
            self.model_id = model_name
            results_dir_name = model_name
        else:
            self.model_name = model_name
            self.model_id = model_name
            # Create directory name from model name
            results_dir_name = model_name.split('/')[-1].replace(':', '_').replace('.gguf', '')
        
        self.date_str = datetime.now().strftime("%Y-%m-%d")
        
        # Determine the correct results directory path
        current_dir = os.getcwd()
        if os.path.basename(current_dir) == 'client':
            self.results_dir = os.path.join(os.path.dirname(current_dir), "results", results_dir_name)
        elif os.path.basename(current_dir) == 'benchmarks':
            self.results_dir = os.path.join(current_dir, "results", results_dir_name)
        elif os.path.exists(os.path.join(current_dir, 'benchmarks')):
            self.results_dir = os.path.join(current_dir, "benchmarks", "results", results_dir_name)
        else:
            self.results_dir = os.path.join("benchmarks", "results", results_dir_name)
        
        self.server_config = server_config
        
        # Raw MTEB results folder (sibling to model results folder)
        self.raw_results_dir = os.path.join(os.path.dirname(self.results_dir), "mteb_raw", results_dir_name)
    
    def get_raw_results_path(self) -> str:
        """Get path for raw MTEB results (prediction_folder)"""
        os.makedirs(self.raw_results_dir, mode=0o777, exist_ok=True)
        return self.raw_results_dir
    
    def create_results_directory(self):
        """Create the results directory structure"""
        try:
            os.makedirs(self.results_dir, mode=0o777, exist_ok=True)
            logger.info(f"Created directory: {self.results_dir}")
        except Exception as e:
            logger.error(f"Error creating directory: {e}")
            raise
    
    def format_markdown(self, dataset_results: dict[str, dict[str, float]],
                       device: str = "unknown") -> str:
        """
        Format benchmark results into markdown content.
        
        Args:
            dataset_results: Dictionary mapping dataset name to metrics
            device: Device used for inference
            
        Returns:
            Formatted markdown string
        """
        sections = []
        
        # Header
        sections.append(f"""# Benchmark Results for {self.model_name.split('/')[-1]}
**Date:** {self.date_str}  
**Model:** {self.model_name}""")
        
        # Dataset list
        datasets = list(dataset_results.keys())
        sections.append(f"\n**Datasets:** {', '.join(datasets)}")
        
        num_samples = self.server_config.get_num_samples()
        if num_samples:
            sections.append(f"**Samples:** {num_samples}")
        else:
            sections.append("**Samples:** Full dataset")
        sections.append("")
        
        # Scores table
        sections.append("\n## Scores")
        sections.append("")
        sections.append("| Dataset | nDCG@10 | MRR@10 | Recall@10 | Precision@10 |")
        sections.append("|---------|---------|--------|-----------|--------------|")
        
        for dataset_name, metrics in dataset_results.items():
            ndcg = metrics.get('ndcg_at_10', 0) * 100
            mrr = metrics.get('mrr_at_10', 0) * 100
            recall = metrics.get('recall_at_10', 0) * 100
            precision = metrics.get('precision_at_10', 0) * 100
            sections.append(f"| {dataset_name} | {ndcg:.2f}% | {mrr:.2f}% | {recall:.2f}% | {precision:.2f}% |")
        
        # Configuration section
        sections.append("\n## Model Configuration")
        sections.append(f"- **Device:** {self.server_config.device}")
        sections.append(f"- **GPU Layers:** {self.server_config.gpu_layers}")
        sections.append(f"- **Context Size:** {self.server_config.ctx_size} tokens")
        sections.append(f"- **Batch Size (tokens):** {self.server_config.batch_size}")
        sections.append(f"- **HTTP Batch Size:** {self.server_config.get_http_batch_size()} sentences/request")
        sections.append("")
        
        return "\n".join(sections)
    
    def format_comparative_markdown(self, addon_name: str, transformers_name: str,
                                   dataset_comparisons: dict[str, Any],
                                   transformers_dtype: str = None,
                                   addon_quantization: str = None) -> str:
        """
        Format comparative evaluation results into markdown.
        
        Args:
            addon_name: Name of the addon model
            transformers_name: Name of the transformers model
            dataset_comparisons: Dictionary of comparison results per dataset
            transformers_dtype: Dtype used for transformers model (e.g., "float16", "float32")
            addon_quantization: Quantization used for addon GGUF model (e.g., "F16", "Q8_0")
            
        Returns:
            Formatted markdown string
        """
        sections = []
        
        # Header
        sections.append(f"""# Comparative Benchmark Results
**Date:** {self.date_str}  
**Addon Model (@qvac/embed-llamacpp):** {addon_name}  
**Transformers Model (SentenceTransformers):** {transformers_name}  
""")
        
        num_samples = self.server_config.get_num_samples()
        if num_samples:
            sections.append(f"**Samples per dataset:** {num_samples}")
        else:
            sections.append("**Samples:** Full dataset")
        
        sections.append("""
## Comparison Type
- **Addon**: Native C++ LlamaCpp implementation with GGUF model
- **Transformers**: Python SentenceTransformers implementation

---
""")
        
        # Summary table - nDCG
        sections.append("## Results Summary (nDCG@10)\n")
        sections.append("| Dataset | Addon | Transformers | Difference | Winner |")
        sections.append("|---------|-------|--------------|------------|--------|")
        
        for dataset_name, comparison in dataset_comparisons.items():
            addon_score = comparison.get('addon_ndcg_at_10', 0) * 100
            trans_score = comparison.get('transformers_ndcg_at_10', 0) * 100
            diff = addon_score - trans_score
            winner = "Addon" if diff > 0 else "Transformers" if diff < 0 else "Tie"
            
            sections.append(
                f"| {dataset_name} | {addon_score:.2f}% | {trans_score:.2f}% | {diff:+.2f}% | {winner} |"
            )
        
        sections.append("\n---\n")
        
        # Detailed results per dataset
        sections.append("## Detailed Results\n")
        
        for dataset_name, comparison in dataset_comparisons.items():
            sections.append(f"### {dataset_name}\n")
            sections.append("| Metric | Addon | Transformers |")
            sections.append("|--------|-------|--------------|")
            
            for metric in ['ndcg_at_10', 'mrr_at_10', 'recall_at_10', 'precision_at_10']:
                addon_val = comparison.get(f'addon_{metric.replace("_at_", "@")}', comparison.get(f'addon_{metric}', 0))
                trans_val = comparison.get(f'transformers_{metric.replace("_at_", "@")}', comparison.get(f'transformers_{metric}', 0))
                
                # Handle both naming conventions
                if addon_val == 0:
                    addon_val = comparison.get(f'addon_{metric.split("_")[0]}', 0)
                if trans_val == 0:
                    trans_val = comparison.get(f'transformers_{metric.split("_")[0]}', 0)
                
                metric_display = metric.replace('_at_', '@')
                sections.append(f"| {metric_display} | {addon_val*100:.2f}% | {trans_val*100:.2f}% |")
            
            sections.append("")
        
        # Configuration section
        sections.append("## Model Configuration")
        sections.append(f"- **Device:** {self.server_config.device}")
        sections.append(f"- **GPU Layers:** {self.server_config.gpu_layers}")
        sections.append(f"- **Context Size:** {self.server_config.ctx_size} tokens")
        sections.append(f"- **Batch Size (tokens):** {self.server_config.batch_size}")
        sections.append(f"- **HTTP Batch Size:** {self.server_config.get_http_batch_size()} sentences/request")
        if addon_quantization:
            sections.append(f"- **Addon quantization:** {addon_quantization}")
        if transformers_dtype:
            sections.append(f"- **Transformers dtype:** {transformers_dtype}")
        sections.append("\n*Both implementations used the same context size and batch settings for fair comparison.*")
        
        # Precision note
        sections.append("\n**Precision:**")
        if addon_quantization:
            sections.append(f"- Addon uses GGUF {addon_quantization} quantization")
        else:
            sections.append("- Addon uses GGUF format (quantization specified in model name: F32, F16, Q8_0, etc.)")
        if transformers_dtype:
            sections.append(f"- Transformers uses PyTorch {transformers_dtype}")
        sections.append("- Dtype auto-matches: specifying :F16 on one model applies to both unless both explicitly set")
        
        # Footer
        sections.append(f"\n---\n*Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} by EmbedLlamacpp Benchmark Suite*")
        
        return "\n".join(sections)
    
    def save_results(self, md_content: str):
        """Save results to a markdown file"""
        os.makedirs(self.results_dir, mode=0o777, exist_ok=True)
        
        output_file = os.path.join(self.results_dir, f"{self.date_str}.md")
        try:
            with open(output_file, "w", encoding='utf-8') as f:
                f.write(md_content)
            logger.info(f"Successfully wrote results to: {output_file}")
        except Exception as e:
            logger.error(f"Error writing to file: {e}")
            raise
    
    def print_results(self, dataset_results: dict[str, dict[str, float]]):
        """Print results summary to terminal"""
        print("\n" + "=" * 70)
        print("EVALUATION RESULTS")
        print("=" * 70)
        
        for dataset_name, metrics in dataset_results.items():
            print(f"\n{dataset_name}")
            print("-" * 40)
            print(f"  nDCG@10:      {metrics.get('ndcg_at_10', 0)*100:.2f}%")
            print(f"  MRR@10:       {metrics.get('mrr_at_10', 0)*100:.2f}%")
            print(f"  Recall@10:    {metrics.get('recall_at_10', 0)*100:.2f}%")
            print(f"  Precision@10: {metrics.get('precision_at_10', 0)*100:.2f}%")
        
        # Print configuration
        print("\n" + "-" * 70)
        print("Configuration:")
        print(f"  Device: {self.server_config.device}")
        print(f"  GPU Layers: {self.server_config.gpu_layers}")
        print(f"  Context Size: {self.server_config.ctx_size} tokens")
        print(f"  Batch Size: {self.server_config.batch_size} tokens")
        print(f"  HTTP Batch: {self.server_config.get_http_batch_size()} sentences/request")
        
        print("\n" + "=" * 70)
        print(f"Results saved to: {self.results_dir}")
        print("=" * 70)
