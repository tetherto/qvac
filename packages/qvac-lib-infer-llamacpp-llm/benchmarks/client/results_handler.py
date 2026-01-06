# benchmarks/client/results_handler.py
import os
from datetime import datetime
import logging
from model_handler import ServerConfig
logger = logging.getLogger(__name__)

class ResultsHandler:
    def __init__(self, model_name: str, server_config: ServerConfig):
        # For comparative mode, model_name contains "_vs_" format - preserve it!
        is_comparative = "_vs_" in model_name
        
        if is_comparative:
            # Comparative mode: use the full _vs_ name for directory
            self.model_name = model_name
            self.model_id = model_name
            results_dir_name = model_name
        else:
            # Regular mode with direct model name
            self.model_name = model_name
            self.model_id = model_name
            # Create directory name from model name (handle colons and slashes)
            # e.g., "unsloth/Qwen3-1.7B-GGUF:Q4_0" -> "Qwen3-1.7B-GGUF_Q4_0"
            # e.g., "hd://key/model.gguf" -> "model"
            results_dir_name = model_name.split('/')[-1].replace(':', '_').replace('.gguf', '')
        
        self.date_str = datetime.now().strftime("%Y-%m-%d")
        
        # Determine the correct results directory path
        # When running from benchmarks/client/, we need to go up one level
        current_dir = os.getcwd()
        if os.path.basename(current_dir) == 'client':
            # Running from benchmarks/client/ - go up one level to benchmarks/
            self.results_dir = os.path.join(os.path.dirname(current_dir), "results", results_dir_name)
        elif os.path.basename(current_dir) == 'benchmarks':
            # Running from benchmarks/ directory
            self.results_dir = os.path.join(current_dir, "results", results_dir_name)
        elif os.path.exists(os.path.join(current_dir, 'benchmarks')):
            # Running from project root
            self.results_dir = os.path.join(current_dir, "benchmarks", "results", results_dir_name)
        else:
            # Fallback to relative path (shouldn't happen normally)
            self.results_dir = os.path.join("benchmarks", "results", results_dir_name)
        
        self.server_config = server_config
        
    def create_results_directory(self):
        """Create the results directory structure"""
        try:
            os.makedirs(self.results_dir, mode=0o777, exist_ok=True)
            logger.info(f"Created directory: {self.results_dir}")
        except Exception as e:
            logger.error(f"Error creating directory: {e}")
            raise
    
    def format_markdown(self, squad_results: dict = None, arc_results: dict = None, mmlu_results: dict = None, gsm8k_results: dict = None, device: str = "unknown") -> str:
        """Format the results into markdown content"""
        sections = []
        
        # Header
        sections.append(f"""# Benchmark Results for {self.model_name.split('/')[-1]}
**Date:** {self.date_str}  
**Model:** {self.model_name}""")

        # Dataset list with samples
        datasets = []
        if squad_results: datasets.append("SQuAD")
        if arc_results: datasets.append("ARC")
        if mmlu_results: datasets.append("MMLU")
        if gsm8k_results: datasets.append("GSM8K")
        sections.append(f"\n**Dataset:** {', '.join(datasets)}")
        sections.append(f"**Samples:** {self.server_config.get_num_samples()}")
        sections.append("")

        # Scores section as table
        sections.append("\n## Scores")
        sections.append("")
        sections.append("| Dataset | Metric | Score |")
        sections.append("|---------|--------|-------|")
        
        if squad_results:
            sections.append(f"| SQuAD | F1 Score | {squad_results['squad_f1'] * 100:.2f}% |")
        
        if arc_results:
            sections.append(f"| ARC | Accuracy | {arc_results['arc_accuracy'] * 100:.2f}% |")
        
        if mmlu_results:
            sections.append(f"| MMLU | Accuracy | {mmlu_results['mmlu_accuracy'] * 100:.2f}% |")

        if gsm8k_results:
            sections.append(f"| GSM8K | Accuracy | {gsm8k_results['gsm8k_accuracy'] * 100:.2f}% |")

        # Model configuration section with ALL parameters
        sections.append("\n## Model Configuration")
        sections.append(f"- **Temperature:** {self.server_config.temp}")
        sections.append(f"- **Top-P:** {self.server_config.top_p}")
        sections.append(f"- **Top-K:** {self.server_config.top_k}")
        sections.append(f"- **Max Tokens (n_predict):** {self.server_config.n_predict}")
        sections.append(f"- **Repeat Penalty:** {self.server_config.repeat_penalty}")
        sections.append(f"- **Seed:** {self.server_config.seed}")
        sections.append(f"- **Context Window Size (ctx_size):** {self.server_config.ctx_size}")
        sections.append(f"- **GPU Layers:** {self.server_config.gpu_layers}")
        sections.append(f"- **Device:** {self.server_config.device}")
        
        sections.append("")

        return "\n".join(sections)
    
    def save_results(self, md_content: str):
        """Save the results to a markdown file"""
        # Ensure directory exists before writing
        os.makedirs(self.results_dir, mode=0o777, exist_ok=True)
        
        output_file = os.path.join(self.results_dir, f"{self.date_str}.md")
        try:
            with open(output_file, "w", encoding='utf-8') as f:
                f.write(md_content)
            logger.info(f"Successfully wrote results to: {output_file}")
        except Exception as e:
            logger.error(f"Error writing to file: {e}")
            raise
    
    def print_results(self, md_content: str):
        """Print the results to the terminal with clear dataset labels"""
        print("\n" + "=" * 70)
        print("📊 EVALUATION RESULTS")
        print("=" * 70)
        
        # Parse and print with clear formatting
        lines = md_content.split('\n')
        current_section = None
        in_config = False
        
        for line in lines:
            # Detect main section headers
            if line.startswith('## '):
                current_section = line.replace('## ', '').strip()
                if current_section == "Model Configuration":
                    in_config = True
                    print(f"\n⚙️  {current_section}")
                    print("-" * 70)
                elif current_section == "Scores":
                    in_config = False
                    # Skip printing "Scores" header, let datasets print themselves
                    continue
            # Detect dataset section headers (###)
            elif line.startswith('### '):
                subsection = line.replace('### ', '').strip()
                if not in_config:
                    # Dataset results
                    print(f"\n📈 {subsection}")
                    print("-" * 40)
                else:
                    # Config subsection
                    print(f"\n  {subsection}:")
            # Print other lines
            elif line.strip() and not line.startswith('#') and not line.startswith('---'):
                if in_config:
                    # Indent config lines
                    print(f"  {line}")
                else:
                    print(line)
        
        print("\n" + "=" * 70)
    
    def format_comparative_markdown(self, 
                                   addon_name: str,
                                   transformers_name: str,
                                   dataset_comparisons: dict) -> str:
        """
        Format comparative evaluation results into markdown
        
        Args:
            addon_name: Name of the addon/GGUF model
            transformers_name: Name of the transformers model
            dataset_comparisons: Dictionary of dataset comparison results
            
        Returns:
            Formatted markdown string
        """
        sections = []
        
        # Header
        sections.append(f"""# Comparative Benchmark Results
**Date:** {self.date_str}  
**Addon Model (@qvac/llm-llamacpp):** {addon_name}  
**Transformers Model (HuggingFace):** {transformers_name}  
**Samples:** {self.server_config.get_num_samples()}

## Comparison Type
- **Addon**: Native C++ LlamaCpp implementation with GGUF model
- **Transformers**: Pure Python PyTorch implementation

---
""")
        
        # Summary table
        sections.append("## Results Summary\n")
        sections.append("| Dataset | Metric | Addon | Transformers | Winner |")
        sections.append("|---------|--------|-------|--------------|--------|")
        
        for dataset_name, comparison in dataset_comparisons.items():
            report = comparison.get_comparison_report()
            
            # Get the actual metric name from the comparison
            metric_name_key = report.get('metric_name', 'accuracy')
            
            # Map metric names to display names
            metric_display_names = {
                'f1': 'F1 Score',
                'accuracy': 'Accuracy'
            }
            metric_display_name = metric_display_names.get(metric_name_key, metric_name_key.title())
            
            # Get the score from the report using the actual metric name
            addon_score = report['addon_metrics'].get(metric_name_key, 0) * 100
            trans_score = report['transformers_metrics'].get(metric_name_key, 0) * 100
            
            diff = addon_score - trans_score
            winner = "Addon 🏆" if diff > 0 else "Transformers 🏆" if diff < 0 else "Tie 🤝"
            
            sections.append(
                f"| {dataset_name.upper()} | {metric_display_name} | {addon_score:.2f}% | {trans_score:.2f}% | {winner} |"
            )
        
        sections.append("\n---\n")
        
        # Configuration section - parameters used by BOTH implementations for fair comparison
        sections.append("## Model Configuration")
        sections.append(f"- **Temperature:** {self.server_config.temp}")
        sections.append(f"- **Top-P:** {self.server_config.top_p}")
        sections.append(f"- **Top-K:** {self.server_config.top_k}")
        sections.append(f"- **Max Tokens (n_predict):** {self.server_config.n_predict}")
        sections.append(f"- **Repeat Penalty:** {self.server_config.repeat_penalty}")
        sections.append(f"- **Seed:** {self.server_config.seed}")
        sections.append(f"- **Context Window Size (ctx_size):** {self.server_config.ctx_size}")
        sections.append(f"- **GPU Layers:** {self.server_config.gpu_layers}")
        sections.append(f"- **Device:** {self.server_config.device}")
        sections.append("\n*All parameters above are used by both implementations for a fair comparison.*")
        
        # Footer
        sections.append(f"\n---\n*Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} by LlamaCpp Benchmark Suite*")
        
        return "\n".join(sections)