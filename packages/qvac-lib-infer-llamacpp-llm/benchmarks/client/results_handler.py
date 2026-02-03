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
            results_dir_name = model_name.split('/')[-1].replace(':', '_').replace('.gguf', '')
        self.date_str = datetime.now().strftime("%Y-%m-%d")
        self.results_dir = os.path.join("benchmarks/client/benchmarking_results", results_dir_name)
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

        # Dataset list
        datasets = []
        if squad_results: datasets.append("SQuAD")
        if arc_results: datasets.append("ARC")
        if mmlu_results: datasets.append("MMLU")
        if gsm8k_results: datasets.append("GSM8K")
        sections.append(f"\n**Dataset:** {', '.join(datasets)}")

        # Scores section
        sections.append("\n## Scores")
        
        if squad_results:
            sections.append(f"""### SQuAD
- **Exact Match:** {squad_results['squad_exact_match']:.4f}%
- **F1 Score:** {squad_results['squad_f1']:.4f}%
- **Samples:** {squad_results['samples']}""")
        
        if arc_results:
            sections.append(f"""### ARC
- **Accuracy:** {arc_results['arc_accuracy'] * 100:.4f}%
- **Samples:** {arc_results['samples']}""")
        
        if mmlu_results:
            sections.append(f"""### MMLU
- **Accuracy:** {mmlu_results['mmlu_accuracy'] * 100:.4f}%
- **Samples:** {mmlu_results['samples']}""")

        if gsm8k_results:
            sections.append(f"""### GSM8K
- **Accuracy:** {gsm8k_results['gsm8k_accuracy'] * 100:.4f}%
- **Samples:** {gsm8k_results['samples']}""")

        # Performance and Notes sections
        # Print model_config if in P2P mode, else print server config
        is_p2p = getattr(self.server_config, 'hyperdrive_key', None) and getattr(self.server_config, 'p2p_model_name', None)
        if is_p2p and getattr(self.server_config, 'p2p_model_config', None):
            model_config = self.server_config.p2p_model_config
            config_lines = [f"- {k}: {v}" for k, v in model_config.items()]
            notes_section = "## Performance\n\n## Model Configuration (P2P)\n" + "\n".join(config_lines)
        else:
            notes_section = f"""## Performance\n\n## Configuration\n- Temperature: {self.server_config.temperature}\n- Top-p: {self.server_config.top_p}\n- Context Window Size: {self.server_config.context_window_size}\n- Prefill Chunk Size: {self.server_config.prefill_chunk_size}\n- Max-tokens: {self.server_config.max_tokens}"""
        sections.append(notes_section)

        return "\n".join(sections)
    
    def save_results(self, md_content: str):
        """Save the results to a markdown file"""
        output_file = os.path.join(self.results_dir, f"{self.date_str}.md")
        try:
            with open(output_file, "w", encoding='utf-8') as f:
                f.write(md_content)
            logger.info(f"Successfully wrote results to: {output_file}")
        except Exception as e:
            logger.error(f"Error writing to file: {e}")
            raise
    
    def print_results(self, md_content: str):
        """Print the results to the terminal"""
        logger.info("\nEvaluation Results:")
        logger.info("=" * 50)
        logger.info(md_content)
        logger.info("=" * 50)