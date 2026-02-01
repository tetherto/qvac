#!/usr/bin/env python3
# evaluate_embed.py - Main entry point for embeddings benchmark

import argparse
import asyncio
import logging
import os
import sys

from model_handler import QvacEmbedHandler, MTEBModelWrapper, ServerConfig, download_gguf_from_huggingface
from results_handler import ResultsHandler
from utils import load_mteb_tasks, AVAILABLE_DATASETS

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("sentence_transformers").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


def setup_argument_parser():
    """Set up and return the argument parser"""
    parser = argparse.ArgumentParser(
        description="Evaluate embedding models on MTEB benchmarks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Download from HuggingFace (auto-download)
  python evaluate_embed.py --gguf-model "ChristianAzinn/gte-large-gguf:F16"
  
  # P2P model via Hyperdrive
  python evaluate_embed.py --gguf-model "hd://KEY/gte-large_fp16.gguf"
  
  # Comparative mode - test both addon (GGUF) and SentenceTransformers
  python evaluate_embed.py --compare --gguf-model "ChristianAzinn/gte-large-gguf:F16" --transformers-model "thenlper/gte-large"
  
  # Specific datasets only
  python evaluate_embed.py --gguf-model "ChristianAzinn/gte-large-gguf" --datasets "ArguAna,SciFact"
        """
    )
    
    # Model specification
    parser.add_argument("--gguf-model", required=True,
                       help="GGUF model specification. Formats: HuggingFace 'owner/repo' or 'owner/repo:quantization', P2P 'hd://key/model.gguf'")
    parser.add_argument("--hf-token",
                       help="HuggingFace token for accessing gated models")
    
    # Comparative mode
    parser.add_argument("--compare", "--compare-implementations", action="store_true",
                       dest="compare", help="Compare GGUF addon vs SentenceTransformers")
    parser.add_argument("--transformers-model",
                       help="HuggingFace model name for SentenceTransformers (required with --compare)")
    
    # Benchmark settings
    parser.add_argument("--samples", type=int,
                       help="Number of samples per dataset (default: full dataset)")
    parser.add_argument("--datasets",
                       help=f"Comma-separated list of datasets or 'all' (default: all). Available: {', '.join(AVAILABLE_DATASETS)}")
    
    # Model parameters
    parser.add_argument("--device", choices=['cpu', 'gpu'], default='gpu',
                       help="Device type (default: gpu)")
    parser.add_argument("--batch-size", type=int, default=2048,
                       help="Tokens available for processing multiple prompts together (default: 2048)")
    parser.add_argument("--gpu-layers", type=str, default='99',
                       help="Number of GPU layers to offload (default: 99)")
    parser.add_argument("--ctx-size", type=int, default=512,
                       help="Context window size (default: 512)")
    parser.add_argument("--verbosity", type=str, default='0',
                       help="Verbosity level 0-3 (default: 0)")
    
    # Server settings
    parser.add_argument("--port", type=int, default=7357,
                       help="Server port (default: 7357)")
    
    return parser


def parse_gguf_model_spec(args):
    """Parse GGUF model specification into appropriate format"""
    args.hyperdrive_uri = None
    args.hf_gguf_repo = None
    args.hf_gguf_quantization = None
    
    if not args.gguf_model:
        return
    
    # Check if it's a P2P hyperdrive URI
    if args.gguf_model.startswith("hd://"):
        hd_uri = args.gguf_model[5:]
        if "/" not in hd_uri:
            logger.error("Hyperdrive URI must include model filename (Format: hd://key/model.gguf)")
            sys.exit(1)
        args.hyperdrive_uri = args.gguf_model
        args.hd_model_name = args.hyperdrive_uri.split("/")[-1].replace(".gguf", "")
    else:
        # Treat everything else as HuggingFace repo
        args.hf_gguf_repo = args.gguf_model
        if ":" in args.gguf_model:
            repo, quant = args.gguf_model.rsplit(":", 1)
            args.hf_gguf_repo = repo
            args.hf_gguf_quantization = quant.upper()


def validate_args(args):
    """Validate required arguments"""
    if not args.gguf_model:
        logger.error("--gguf-model is required")
        sys.exit(1)
    
    if args.compare and not args.transformers_model:
        logger.error("--transformers-model is required when using --compare")
        sys.exit(1)
    
    # Clean up empty HF token
    if args.hf_token and args.hf_token.strip() == "":
        args.hf_token = None


def log_configuration(server_config, args, model_display_name):
    """Log active configuration"""
    logger.info("=" * 70)
    logger.info("ACTIVE CONFIGURATION")
    logger.info("=" * 70)
    logger.info("Model Parameters:")
    logger.info(f"   Model: {model_display_name}")
    logger.info(f"   Device: {server_config.device}")
    logger.info(f"   GPU Layers: {server_config.gpu_layers}")
    logger.info(f"   Context Size: {server_config.ctx_size}")
    logger.info(f"   Batch Size: {server_config.batch_size} tokens")
    logger.info("")
    logger.info("Benchmark Settings:")
    logger.info(f"   Datasets: {server_config.get_enabled_datasets()}")
    samples = server_config.get_num_samples()
    logger.info(f"   Samples per dataset: {samples if samples else 'Full dataset'}")
    logger.info(f"   HTTP Batch: {server_config.get_http_batch_size()} sentences/request (auto-derived)")
    logger.info(f"   Server port: {args.port}")
    if args.hyperdrive_uri:
        logger.info(f"   Hyperdrive URI: {args.hyperdrive_uri}")
    if args.compare:
        logger.info(f"   Mode: Comparative (addon vs {args.transformers_model})")
    else:
        logger.info("   Mode: Single model evaluation")
    logger.info("=" * 70)
    logger.info("")


def setup_gguf_model(args, server_config):
    """Download and setup GGUF model, returns model_display_name"""
    # HuggingFace GGUF models - download if needed
    if args.hf_gguf_repo:
        logger.info(f"HuggingFace GGUF model specified: {args.hf_gguf_repo}")
        downloaded_path = download_gguf_from_huggingface(
            repo_id=args.hf_gguf_repo,
            quantization=args.hf_gguf_quantization,
            hf_token=args.hf_token
        )
        
        model_filename = os.path.basename(downloaded_path)
        models_dir = os.path.dirname(downloaded_path)
        
        logger.info(f"Using downloaded model: {model_filename}")
        
        server_config.selected_model = {
            'name': model_filename,
            'diskPath': models_dir
        }
        
        model_display_name = args.hf_gguf_repo
        if args.hf_gguf_quantization:
            model_display_name = f"{args.hf_gguf_repo}:{args.hf_gguf_quantization}"
        
        return model_display_name
    
    # Hyperdrive P2P models
    if args.hyperdrive_uri:
        logger.info(f"P2P model via Hyperdrive: {args.hyperdrive_uri}")
        # hyperdrive_key and p2p_model_name already set in ServerConfig
        return args.gguf_model
    
    logger.error("Could not determine model type from --gguf-model")
    sys.exit(1)


def run_comparative_mode(args, server_config, model_display_name):
    """Run comparative evaluation mode"""
    from comparative_evaluator import ComparativeEvaluator
    
    logger.info("Running comparative evaluation mode")
    logger.info(f"Addon GGUF model: {model_display_name}")
    logger.info(f"SentenceTransformers model: {args.transformers_model}")
    
    # Determine directory name for results
    if args.hf_gguf_repo:
        model_dir_name = args.hf_gguf_repo.split("/")[-1]
        if args.hf_gguf_quantization:
            model_dir_name = f"{model_dir_name}_{args.hf_gguf_quantization}"
    elif args.hyperdrive_uri:
        model_dir_name = args.hyperdrive_uri.split("/")[-1].replace(".gguf", "")
    else:
        model_dir_name = args.gguf_model.replace('.gguf', '')
    
    # Create results handler
    results_handler = ResultsHandler(
        f"{model_dir_name}_vs_{args.transformers_model.replace('/', '_')}",
        server_config
    )
    results_handler.create_results_directory()
    
    # Create and run comparative evaluator
    # Pass gguf_model for dtype matching (e.g., :F16 on GGUF matches transformers)
    evaluator = ComparativeEvaluator(
        addon_config=server_config,
        transformers_model_name=args.transformers_model,
        results_handler=results_handler,
        gguf_model_name=args.gguf_model
    )
    
    try:
        asyncio.run(evaluator.run_evaluation())
    except Exception as e:
        logger.error(f"Failed to run comparative evaluation: {e}")
        import traceback
        traceback.print_exc()
        try:
            asyncio.run(evaluator.cleanup_handlers())
        except:
            pass
        sys.exit(1)


def run_single_model_mode(args, server_config, model_display_name):
    """Run single-model evaluation mode"""
    import mteb
    
    logger.info(f"Running single model evaluation for: {model_display_name}")
    
    # Create handler and wrapper
    handler = QvacEmbedHandler(server_config)
    
    # For P2P models, wait for the model to be fully downloaded from Hyperdrive
    handler.wait_for_model_ready()
    
    model_wrapper = MTEBModelWrapper(
        handler, 
        batch_size=server_config.get_http_batch_size(),
        max_seq_length=int(server_config.ctx_size)
    )
    
    # Determine directory name for results
    if args.hf_gguf_repo:
        model_dir_name = args.hf_gguf_repo.split("/")[-1]
        if args.hf_gguf_quantization:
            model_dir_name = f"{model_dir_name}_{args.hf_gguf_quantization}"
    elif args.hyperdrive_uri:
        model_dir_name = args.hyperdrive_uri.split("/")[-1].replace(".gguf", "")
    else:
        model_dir_name = args.gguf_model.replace('.gguf', '')
    
    # Create results handler
    results_handler = ResultsHandler(model_dir_name, server_config)
    results_handler.create_results_directory()
    
    try:
        # Load MTEB tasks with optional query subsampling
        enabled_datasets = server_config.get_enabled_datasets()
        num_samples = server_config.get_num_samples()
        tasks = load_mteb_tasks(enabled_datasets, num_samples=num_samples)
        
        # Run MTEB evaluation using the new mteb.evaluate() API
        samples_info = f" (subsampled to {num_samples} queries)" if num_samples else ""
        logger.info(f"Running MTEB evaluation on {len(tasks)} datasets{samples_info}...")
        
        # Save raw MTEB results for debugging/analysis
        raw_results_folder = results_handler.get_raw_results_path()
        
        model_result = mteb.evaluate(
            model=model_wrapper,
            tasks=tasks,
            encode_kwargs={"batch_size": server_config.get_http_batch_size()},
            raise_error=True,
            show_progress_bar=True,
            cache=None,  # Disable MTEB cache
            prediction_folder=raw_results_folder
        )
        
        # Parse and format results from ModelResult
        dataset_results = {}
        for task_result in model_result.task_results:
            dataset_name = task_result.task_name
            
            test_scores = task_result.scores.get('test', [])
            if test_scores and len(test_scores) > 0:
                scores = test_scores[0]
                dataset_results[dataset_name] = {
                    'ndcg_at_10': scores.get('ndcg_at_10', 0),
                    'mrr_at_10': scores.get('mrr_at_10', 0),
                    'recall_at_10': scores.get('recall_at_10', 0),
                    'precision_at_10': scores.get('precision_at_10', 0)
                }
        
        # Save and print results
        md_content = results_handler.format_markdown(dataset_results, server_config.device)
        results_handler.save_results(md_content)
        results_handler.print_results(dataset_results)
        
        logger.info("Evaluation completed successfully!")
        
    except Exception as e:
        logger.error(f"Evaluation failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        handler.close()


def main():
    """Main entry point"""
    # Parse arguments
    parser = setup_argument_parser()
    args = parser.parse_args()
    
    # Parse model specification
    parse_gguf_model_spec(args)
    
    # Validate
    validate_args(args)
    
    # Create configuration
    server_config = ServerConfig(
        url=f"http://localhost:{args.port}/run",
        hyperdrive_uri=args.hyperdrive_uri,
        cli_samples=args.samples,
        cli_datasets=args.datasets,
        cli_device=args.device,
        cli_batch_size=args.batch_size,
        cli_gpu_layers=args.gpu_layers,
        cli_ctx_size=args.ctx_size,
        cli_verbosity=args.verbosity
    )
    
    # Setup model (download if needed)
    model_display_name = setup_gguf_model(args, server_config)
    
    # Log configuration
    log_configuration(server_config, args, model_display_name)
    
    # Run appropriate mode
    if args.compare:
        run_comparative_mode(args, server_config, model_display_name)
    else:
        run_single_model_mode(args, server_config, model_display_name)


if __name__ == "__main__":
    main()
