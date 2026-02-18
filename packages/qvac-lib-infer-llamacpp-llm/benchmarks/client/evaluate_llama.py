# evaluate_llama.py - Refactored main structure
from model_handler import QvacModelHandler, ServerConfig, ModelEvaluator, download_gguf_from_huggingface
from results_handler import ResultsHandler
from utils import get_dataset_configs, DatasetLoader
import logging
import numpy as np
import os
import sys
import argparse
import asyncio

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logging.getLogger("transformers").setLevel(logging.ERROR)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


def setup_argument_parser():
    """Set up and return the argument parser"""
    parser = argparse.ArgumentParser(
        description="Evaluate LLM models on various benchmarks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Server-based evaluation using GGUF model from HuggingFace Hub
  python evaluate_llama.py --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --hf-token YOUR_TOKEN
  
  # Server-based evaluation using GGUF model from Hyperdrive P2P
  python evaluate_llama.py --gguf-model "hd://{KEY}/medgemma-4b-it-Q4_1.gguf"
  
  # Comparative mode - test both addon (GGUF) and transformers (PyTorch)
  python evaluate_llama.py --compare-implementations --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --transformers-model "meta-llama/Llama-3.2-1B-Instruct" --hf-token YOUR_TOKEN
        """
    )
    
    parser.add_argument("--hf-token", help="HuggingFace token for accessing models")
    parser.add_argument("--compare-implementations", "--compare", action="store_true", dest="compare_implementations", help="Compare GGUF vs transformers implementations")
    parser.add_argument("--gguf-model", help="GGUF model specification")
    parser.add_argument("--transformers-model", help="HuggingFace model name for transformers comparison")
    
    parser.add_argument("--samples", type=int, help="Number of samples per dataset (default: 10)")
    parser.add_argument("--datasets", help="Comma-separated list of datasets (default: all)")
    parser.add_argument("--device", help="Device type: cpu, gpu (default: gpu)")
    
    parser.add_argument("--temperature", type=float, help="Temperature (default: 0.7)")
    parser.add_argument("--ctx-size", type=int, help="Context window size (default: 8192)")
    parser.add_argument("--gpu-layers", type=str, help="Number of GPU layers (default: 99)")
    parser.add_argument("--top-p", type=float, help="Top-p sampling (default: 0.9)")
    parser.add_argument("--n-predict", type=int, help="Max tokens to predict (default: 4096)")
    parser.add_argument("--top-k", type=int, help="Top-k sampling (default: 40)")
    parser.add_argument("--repeat-penalty", type=float, help="Repeat penalty (default: 1.0)")
    parser.add_argument("--seed", type=int, help="Random seed (default: -1)")
    parser.add_argument("--port", type=int, default=7357, help="Server port (default: 7357)")
    
    return parser


def parse_gguf_model_spec(args):
    """Parse GGUF model specification"""
    args.hyperdrive_uri = None
    
    if not args.gguf_model:
        return
    
    if args.gguf_model.startswith("hd://"):
        hd_uri = args.gguf_model[5:]
        if "/" not in hd_uri:
            logger.error("❌ Hyperdrive URI must include model filename (Format: hd://key/model.gguf)")
            sys.exit(1)
        args.hyperdrive_uri = args.gguf_model
        args.hd_model_name = args.hyperdrive_uri.split("/")[-1].replace(".gguf", "")
    else:
        args.hf_gguf_repo = args.gguf_model
        if ":" in args.gguf_model:
            repo, quant = args.gguf_model.rsplit(":", 1)
            args.hf_gguf_repo = repo
            args.hf_gguf_quantization = quant.upper()
        else:
            args.hf_gguf_quantization = None


def validate_args(args):
    """Validate required arguments"""
    if not args.gguf_model:
        logger.error("--gguf-model is required")
        sys.exit(1)
    
    if args.compare_implementations and not args.transformers_model:
        logger.error("--transformers-model is required when using --compare-implementations")
        sys.exit(1)
    
    if args.hf_token and args.hf_token.strip() == "":
        args.hf_token = None
    if not args.hf_token:
        logger.warning("No HuggingFace token provided. Some models may require authentication.")


def log_configuration(server_config, args):
    """Log active configuration"""
    logger.info("=" * 70)
    logger.info("📋 ACTIVE CONFIGURATION")
    logger.info("=" * 70)
    logger.info("🔧 Model Parameters:")
    logger.info(f"   • temperature: {server_config.temp}")
    logger.info(f"   • top_p: {server_config.top_p}")
    logger.info(f"   • top_k: {server_config.top_k}")
    logger.info(f"   • n_predict: {server_config.n_predict}")
    logger.info(f"   • ctx_size: {server_config.ctx_size}")
    logger.info(f"   • repeat_penalty: {server_config.repeat_penalty}")
    logger.info(f"   • seed: {server_config.seed}")
    logger.info(f"   • gpu_layers: {server_config.gpu_layers}")
    logger.info(f"   • device: {server_config.device}")
    logger.info("")
    logger.info("📊 Benchmark Settings:")
    logger.info(f"   • datasets: {server_config.get_enabled_datasets()}")
    logger.info(f"   • samples per dataset: {server_config.get_num_samples()}")
    logger.info(f"   • server port: {args.port}")
    if args.hyperdrive_uri:
        logger.info(f"   • hyperdrive URI: {args.hyperdrive_uri}")
    logger.info("=" * 70)
    logger.info("")


def setup_gguf_model_for_single_mode(args, server_config):
    """Download and setup GGUF model for single-model mode, returns model_display_name"""
    # HuggingFace GGUF models
    if hasattr(args, 'hf_gguf_repo') and args.hf_gguf_repo:
        server_config.hf_gguf_repo = args.hf_gguf_repo
        server_config.hf_gguf_quantization = getattr(args, 'hf_gguf_quantization', None)
        
        logger.info("📦 HuggingFace GGUF model specified, downloading...")
        downloaded_path = download_gguf_from_huggingface(
            repo_id=args.hf_gguf_repo,
            quantization=args.hf_gguf_quantization,
            hf_token=args.hf_token
        )
        
        model_filename = os.path.basename(downloaded_path)
        models_dir = os.path.dirname(downloaded_path)
        
        logger.info(f"✅ Using downloaded model: {model_filename}")
        
        server_config.selected_model = {
            'name': model_filename,
            'diskPath': models_dir
        }
        
        model_display_name = args.hf_gguf_repo
        if args.hf_gguf_quantization:
            model_display_name = f"{args.hf_gguf_repo}:{args.hf_gguf_quantization}"
        
        print(f"Testing addon: {model_display_name}")
        return model_display_name
    
    # Hyperdrive P2P models - hyperdrive_key and p2p_model_name already set in ServerConfig
    if args.hyperdrive_uri:
        model_display_name = args.gguf_model
        print(f"Testing addon: {model_display_name}")
        return model_display_name
    
    logger.error("Could not determine model name from --gguf-model")
    sys.exit(1)


def run_comparative_mode(args, server_config):
    """Run comparative evaluation mode"""
    from comparative_evaluator import ComparativeEvaluator
    
    logger.info("🔄 Running comparative evaluation mode")
    logger.info(f"Addon GGUF model: {args.gguf_model}")
    logger.info(f"Transformers model: {args.transformers_model}")
    
    # Set HF attributes on server_config for ComparativeEvaluator to use
    if hasattr(args, 'hf_gguf_repo') and args.hf_gguf_repo:
        server_config.hf_gguf_repo = args.hf_gguf_repo
        server_config.hf_gguf_quantization = getattr(args, 'hf_gguf_quantization', None)
    
    # Determine GGUF model name for directory
    if args.hyperdrive_uri:
        gguf_model_dir_name = args.hyperdrive_uri.split("/")[-1].replace(".gguf", "")
    else:
        gguf_model_dir_name = args.hf_gguf_repo.split("/")[-1]
        if args.hf_gguf_quantization:
            gguf_model_dir_name = f"{gguf_model_dir_name}_{args.hf_gguf_quantization}"
    
    # Initialize results handler
    results_handler = ResultsHandler(
        f"{gguf_model_dir_name}_vs_{args.transformers_model.replace('/', '_')}", 
        server_config
    )
    results_handler.create_results_directory()
    
    # Create and run comparative evaluator
    comparative_evaluator = ComparativeEvaluator(
        addon_model_config=server_config,
        transformers_model_name=args.transformers_model,
        hf_token=args.hf_token,
        results_handler=results_handler
    )
    
    try:
        asyncio.run(comparative_evaluator.run_evaluation())
    except Exception as e:
        logger.error(f"Failed to run comparative evaluation: {e}")
        try:
            asyncio.run(comparative_evaluator.cleanup_handlers())
        except:
            pass
        sys.exit(1)


def run_single_model_mode(model_display_name, server_config):
    """Run single-model evaluation mode"""
    # Create handler and evaluator
    qvac_handler = QvacModelHandler(server_config)
    evaluator = ModelEvaluator(qvac_handler, model_display_name)
    results_handler = ResultsHandler(model_display_name, server_config)
    results_handler.create_results_directory()
    
    logger.info(f"Running evaluations on addon model: {model_display_name}")
    logger.info(f"Evaluation mode: Addon (LlamaCpp)")
    
    results = {}
    enabled_datasets = server_config.get_enabled_datasets()
    num_samples = server_config.get_num_samples()
    datasets_with_errors = []
    
    logger.info(f"Enabled datasets: {enabled_datasets}")
    logger.info(f"Number of samples per dataset: {num_samples}")
    
    # Evaluate each dataset
    for dataset_name in enabled_datasets:
        logger.info(f"📊 Evaluating {dataset_name.upper()}...")
        
        # Load dataset
        if dataset_name == 'squad':
            prompts, ground_truths, config = DatasetLoader.load_squad(num_samples)
            metric_key = 'squad_f1'
        elif dataset_name == 'arc':
            prompts, ground_truths, config = DatasetLoader.load_arc(num_samples)
            metric_key = 'arc_accuracy'
        elif dataset_name == 'mmlu':
            prompts, ground_truths, config = DatasetLoader.load_mmlu(num_samples)
            metric_key = 'mmlu_accuracy'
        elif dataset_name == 'gsm8k':
            prompts, ground_truths, config = DatasetLoader.load_gsm8k(num_samples)
            metric_key = 'gsm8k_accuracy'
        else:
            logger.warning(f"Unknown dataset: {dataset_name}, skipping")
            continue
        
        # Evaluate
        scores, error_count = evaluator.evaluate_dataset(
            dataset_name, prompts, ground_truths, 
            config['metric_fn'], config['system_prompt']
        )
        
        # Log progress
        for i in range(0, len(scores), 10):
            if i > 0:
                current_score = np.mean(scores[:i]) * 100.0
                logger.info(f"Progress: {i}/{len(scores)} samples. Current score: {current_score:.2f}%")
        
        # Store results (keep in 0-1 range)
        results[dataset_name] = {
            metric_key: np.mean(scores) if scores else 0.0,
            'samples': len(scores),
            'errors': error_count
        }
        
        if error_count > 0:
            logger.warning(f"⚠️  {error_count} error(s) occurred")
            datasets_with_errors.append((dataset_name, error_count))
    
    evaluator.handler.close()
    
    # Check for errors
    if datasets_with_errors:
        print("\n" + "="*80)
        print("❌ BENCHMARK FAILED - ERRORS DETECTED")
        print("="*80)
        for dataset_name, error_count in datasets_with_errors:
            print(f"   • {dataset_name.upper()}: {error_count} error(s)")
        print("="*80)
        logger.error("Benchmark failed due to errors")
        sys.exit(1)
    
    # Format and save results
    md_content = results_handler.format_markdown(
        squad_results=results.get('squad'),
        arc_results=results.get('arc'),
        mmlu_results=results.get('mmlu'),
        gsm8k_results=results.get('gsm8k'),
        device=server_config.device
    )
    
    results_handler.save_results(md_content)
    results_handler.print_results(md_content)


def main():
    """Main entry point"""
    # Parse arguments
    parser = setup_argument_parser()
    args = parser.parse_args()
    
    # Parse and validate
    parse_gguf_model_spec(args)
    validate_args(args)
    
    # Create configuration
    server_config = ServerConfig(
        url=f"http://localhost:{args.port}/run",
        hyperdrive_uri=args.hyperdrive_uri,
        cli_samples=args.samples,
        cli_datasets=args.datasets,
        cli_device=args.device,
        cli_temperature=args.temperature,
        cli_ctx_size=args.ctx_size,
        cli_gpu_layers=args.gpu_layers,
        cli_top_p=args.top_p,
        cli_n_predict=args.n_predict,
        cli_top_k=args.top_k,
        cli_repeat_penalty=args.repeat_penalty,
        cli_seed=args.seed
    )
    
    # Log configuration
    log_configuration(server_config, args)
    
    # Run appropriate mode
    if args.compare_implementations:
        run_comparative_mode(args, server_config)
    else:
        model_display_name = setup_gguf_model_for_single_mode(args, server_config)
        run_single_model_mode(model_display_name, server_config)


if __name__ == "__main__":
    main()

