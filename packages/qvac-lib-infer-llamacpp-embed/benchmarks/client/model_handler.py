# model_handler.py - Model handlers for embeddings benchmark

import logging
import httpx
import numpy as np
import os
import time
import yaml
from sentence_transformers import SentenceTransformer
from huggingface_hub import hf_hub_download, list_repo_files

logger = logging.getLogger(__name__)


def parse_dtype_suffix(model_name: str) -> tuple[str, str | None]:
    """
    Parse dtype suffix from model name.
    
    Args:
        model_name: Model name potentially with :F16, :F32, etc. suffix
        
    Returns:
        Tuple of (clean_model_name, dtype_str or None)
        dtype_str is one of: "float16", "float32", "bfloat16", or None
    """
    if ":" not in model_name:
        return model_name, None
    
    base_name, suffix = model_name.rsplit(":", 1)
    suffix_upper = suffix.upper()
    
    dtype_map = {
        "F16": "float16", "FP16": "float16", "FLOAT16": "float16",
        "F32": "float32", "FP32": "float32", "FLOAT32": "float32",
        "BF16": "bfloat16", "BFLOAT16": "bfloat16",
    }
    
    if suffix_upper in dtype_map:
        return base_name, dtype_map[suffix_upper]
    
    # Not a dtype suffix (could be quantization like Q4_K_M)
    return model_name, None


def resolve_dtypes(gguf_model: str, transformers_model: str, device: str = "gpu") -> tuple[str, str, str]:
    """
    Resolve effective dtype for both models based on specified suffixes.
    
    Rules:
    1. Both specified → Respect user choices
    2. One specified → Other auto-matches
    3. Neither specified → Auto-detect based on device (CUDA→float16, else→float32)
    
    Args:
        gguf_model: GGUF model name (may have :F16/:F32 suffix for dtype, or :Q4_K_M for quantization)
        transformers_model: Transformers model name (may have :F16/:F32 suffix)
        device: Device setting ("gpu", "cpu", "cuda", "mps")
        
    Returns:
        Tuple of (clean_gguf_model, clean_transformers_model, effective_dtype)
    """
    # Parse dtype from GGUF model - only F16/F32/BF16 are dtype specifiers
    gguf_clean, gguf_dtype = parse_dtype_suffix(gguf_model)
    
    # Parse dtype from transformers model
    trans_clean, trans_dtype = parse_dtype_suffix(transformers_model)
    
    # Determine effective dtype
    if gguf_dtype and trans_dtype:
        # Both specified - use transformers dtype (they should match for fair comparison)
        # Log warning if they differ
        if gguf_dtype != trans_dtype:
            logger.warning(f"GGUF dtype ({gguf_dtype}) differs from transformers dtype ({trans_dtype}). "
                          f"Using transformers dtype. For fair comparison, use same dtype on both.")
        effective_dtype = trans_dtype
    elif gguf_dtype:
        # Only GGUF specified - match transformers to it
        effective_dtype = gguf_dtype
        logger.info(f"Auto-matching transformers dtype to GGUF: {effective_dtype}")
    elif trans_dtype:
        # Only transformers specified - use it
        effective_dtype = trans_dtype
        logger.info(f"Using specified transformers dtype: {effective_dtype}")
    else:
        # Neither specified - auto-detect based on device
        import torch
        device_lower = device.lower()
        if device_lower == "gpu":
            if torch.cuda.is_available():
                effective_dtype = "float16"
            else:
                effective_dtype = "float32"
        elif device_lower == "cuda":
            effective_dtype = "float16"
        else:  # cpu, mps
            effective_dtype = "float32"
        logger.info(f"Auto-detected dtype based on device ({device}): {effective_dtype}")
    
    return gguf_clean, trans_clean, effective_dtype


def _normalize_quantization(quant: str) -> list[str]:
    """
    Normalize quantization string to match common naming conventions.
    Returns list of patterns to search for.
    
    Examples:
        F16 -> ['F16', 'FP16', '_F16', '_FP16']
        Q8_0 -> ['Q8_0', 'Q8.0', 'Q8-0']
    """
    quant_upper = quant.upper()
    patterns = [quant_upper]
    
    # Handle F16/FP16 variations
    if quant_upper == 'F16':
        patterns.extend(['FP16', '_F16', '_FP16'])
    elif quant_upper == 'FP16':
        patterns.extend(['F16', '_F16', '_FP16'])
    elif quant_upper == 'F32':
        patterns.extend(['FP32', '_F32', '_FP32'])
    elif quant_upper == 'FP32':
        patterns.extend(['F32', '_F32', '_FP32'])
    
    return patterns


def _matches_quantization(filename: str, quantization: str) -> bool:
    """Check if filename matches the requested quantization"""
    filename_upper = filename.upper()
    patterns = _normalize_quantization(quantization)
    return any(p in filename_upper for p in patterns)


def download_gguf_from_huggingface(repo_id: str, quantization: str | None = None, hf_token: str | None = None) -> str:
    """
    Download a GGUF model from HuggingFace Hub
    
    Args:
        repo_id: HuggingFace repository ID (e.g., "ChristianAzinn/gte-large-gguf")
        quantization: Specific quantization to download (e.g., "F16", "Q8_0")
        hf_token: HuggingFace authentication token
        
    Returns:
        str: Local path to the downloaded GGUF file
    """
    logger.info(f"Downloading GGUF model from HuggingFace: {repo_id}")
    if quantization:
        logger.info(f"   Quantization: {quantization}")
    
    # Create models directory if it doesn't exist
    models_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'server', 'models')
    os.makedirs(models_dir, exist_ok=True)
    
    try:
        # List available files in the repository
        logger.info(f"   Listing files in repository...")
        files = list_repo_files(repo_id, token=hf_token)
        gguf_files = [f for f in files if f.endswith('.gguf')]
        
        if not gguf_files:
            raise ValueError(f"No GGUF files found in repository {repo_id}")
        
        logger.info(f"   Found {len(gguf_files)} GGUF file(s)")
        
        # Select the file to download
        selected_file = None
        
        if quantization:
            # Try to find match with quantization (handles F16/FP16 variations)
            for f in gguf_files:
                if _matches_quantization(f, quantization):
                    selected_file = f
                    break
            
            if not selected_file:
                raise ValueError(f"No GGUF file found with quantization '{quantization}' in {repo_id}. Available files: {gguf_files}")
        else:
            # No quantization specified, prefer F16/FP16 for embedding models, then Q8, then first available
            f16_files = [f for f in gguf_files if _matches_quantization(f, 'F16')]
            q8_files = [f for f in gguf_files if 'Q8' in f.upper()]
            if f16_files:
                selected_file = f16_files[0]
                logger.info(f"   No quantization specified, using F16 variant: {selected_file}")
            elif q8_files:
                selected_file = q8_files[0]
                logger.info(f"   No quantization specified, using Q8 variant: {selected_file}")
            else:
                selected_file = gguf_files[0]
                logger.info(f"   No quantization specified, using first available: {selected_file}")
        
        logger.info(f"   Selected file: {selected_file}")
        
        # Check if already downloaded
        local_filename = os.path.basename(selected_file)
        local_path = os.path.join(models_dir, local_filename)
        
        if os.path.exists(local_path):
            file_size = os.path.getsize(local_path)
            logger.info(f"   File already exists: {local_path} ({file_size / (1024**2):.1f} MB)")
            return local_path
        
        # Download the file
        logger.info(f"   Downloading to {models_dir}...")
        downloaded_path = hf_hub_download(
            repo_id=repo_id,
            filename=selected_file,
            local_dir=models_dir,
            token=hf_token
        )
        
        file_size = os.path.getsize(downloaded_path)
        logger.info(f"   Downloaded successfully: {downloaded_path} ({file_size / (1024**2):.1f} MB)")
        
        return downloaded_path
        
    except Exception as e:
        logger.error(f"   Failed to download GGUF model: {e}")
        raise

DEFAULT_CONFIG = {
    'gpu_layers': '99',  # Maximum GPU offload for best performance
    'ctx_size': '512',   # GTE-large max sequence length
    'batch_size': '2048',  # Tokens available for processing multiple prompts together
    'device': 'gpu',
    'verbosity': '0'
}


class ServerConfig:
    """Configuration for the benchmark server and model parameters"""
    
    def __init__(self,
                 url: str = "http://localhost:7357/run",
                 timeout: int = 300,
                 server_dir: str = None,
                 hyperdrive_uri: str = None,
                 cli_samples: int = None,
                 cli_datasets: str = None,
                 cli_device: str = None,
                 cli_batch_size: int = None,
                 cli_gpu_layers: str = None,
                 cli_ctx_size: int = None,
                 cli_verbosity: str = None):
        
        self.url = url
        self.timeout = timeout
        
        # Set default server directory
        if server_dir is None:
            current_dir = os.getcwd()
            if os.path.basename(current_dir) == 'client':
                server_dir = os.path.join(os.path.dirname(current_dir), 'server')
            elif os.path.exists(os.path.join(current_dir, 'benchmarks', 'server')):
                server_dir = os.path.join(current_dir, 'benchmarks', 'server')
            else:
                server_dir = os.path.join(current_dir, 'server')
        self.server_dir = server_dir
        
        # Model parameters from DEFAULT_CONFIG
        self.gpu_layers = DEFAULT_CONFIG['gpu_layers']
        self.ctx_size = DEFAULT_CONFIG['ctx_size']
        self.batch_size = DEFAULT_CONFIG['batch_size']  # Tokens for processing multiple prompts
        self.device = DEFAULT_CONFIG['device']
        self.verbosity = DEFAULT_CONFIG['verbosity']
        
        # P2P model parameters - parse hyperdrive URI
        self.hyperdrive_uri = hyperdrive_uri
        if hyperdrive_uri and hyperdrive_uri.startswith("hd://"):
            # Split URI: hd://key/filename
            uri_parts = hyperdrive_uri[5:].split("/", 1)  # Remove 'hd://' prefix
            self.hyperdrive_key = "hd://" + uri_parts[0]
            self.p2p_model_name = uri_parts[1] if len(uri_parts) > 1 else None
        else:
            self.hyperdrive_key = None
            self.p2p_model_name = None
        
        # Set default benchmark configuration
        self.benchmark_config = {
            'datasets': ['ArguAna', 'NFCorpus', 'SciFact', 'TRECCOVID', 'SCIDOCS', 'FiQA2018'],
            'num_samples': None  # None means use full dataset
        }
        
        # Apply CLI overrides
        self.apply_cli_overrides(cli_samples, cli_datasets, cli_device,
                                cli_batch_size, cli_gpu_layers,
                                cli_ctx_size, cli_verbosity)
    
    def apply_cli_overrides(self, cli_samples: int = None, cli_datasets: str = None,
                           cli_device: str = None, cli_batch_size: int = None,
                           cli_gpu_layers: str = None,
                           cli_ctx_size: int = None, cli_verbosity: str = None):
        """Apply CLI argument overrides to configuration"""
        if cli_samples is not None:
            self.benchmark_config['num_samples'] = cli_samples
            print(f"CLI override: num_samples = {cli_samples}")
        
        if cli_datasets is not None:
            datasets_list = [d.strip() for d in cli_datasets.split(',')]
            if 'all' in datasets_list:
                datasets_list = ['ArguAna', 'NFCorpus', 'SciFact', 'TRECCOVID', 'SCIDOCS', 'FiQA2018']
            self.benchmark_config['datasets'] = datasets_list
            print(f"CLI override: datasets = {datasets_list}")
        
        if cli_device is not None:
            self.device = cli_device
            print(f"CLI override: device = {cli_device}")
        
        if cli_batch_size is not None:
            self.batch_size = str(cli_batch_size)
            print(f"CLI override: batch_size = {cli_batch_size}")
        
        if cli_gpu_layers is not None:
            self.gpu_layers = cli_gpu_layers
            print(f"CLI override: gpu_layers = {cli_gpu_layers}")
        
        # Force gpu_layers to 0 when device is CPU
        if self.device == 'cpu':
            self.gpu_layers = '0'
            print("Auto-override: gpu_layers = 0 (CPU mode)")
        
        if cli_ctx_size is not None:
            self.ctx_size = str(cli_ctx_size)
            print(f"CLI override: ctx_size = {cli_ctx_size}")
        
        if cli_verbosity is not None:
            self.verbosity = cli_verbosity
            print(f"CLI override: verbosity = {cli_verbosity}")
    
    def get_enabled_datasets(self) -> list[str]:
        """Get list of enabled datasets"""
        return self.benchmark_config.get('datasets', ['ArguAna', 'NFCorpus', 'SciFact', 'TRECCOVID', 'SCIDOCS', 'FiQA2018'])
    
    def get_num_samples(self) -> int | None:
        """Get number of samples for benchmark (None means use full dataset)"""
        return self.benchmark_config.get('num_samples')
    
    def get_http_batch_size(self) -> int:
        """Auto-derive HTTP batch size (sentences per request) from token batch size.
        
        Formula: batch_size (tokens) / avg_tokens_per_sentence
        Using ~16 tokens/sentence as conservative estimate for embedding models.
        Capped at 256 sentences to avoid huge HTTP payloads.
        """
        token_batch = int(self.batch_size) if self.batch_size else 2048
        # Auto-derive: tokens / ~16 tokens per sentence, capped at 256
        return min(token_batch // 16, 256)
    
    def get_model_config(self) -> dict[str, str]:
        """Get model configuration as a dictionary for sending to server"""
        return {
            'device': self.device,
            'gpu_layers': str(self.gpu_layers),
            'ctx_size': str(self.ctx_size),
            'batch_size': str(self.batch_size),
            'verbosity': str(self.verbosity)
        }


class QvacEmbedHandler:
    """Handler for @qvac/embed-llamacpp addon via HTTP server"""
    
    def __init__(self, server_cfg: ServerConfig):
        self.server_cfg = server_cfg
        self.url = str(server_cfg.url)
        self.timeout = server_cfg.timeout
        self.client = httpx.Client(timeout=self.timeout)
        self.model_name = "embed-llamacpp-addon"
        
        # P2P model parameters (already parsed in ServerConfig)
        self.hyperdrive_key = getattr(server_cfg, 'hyperdrive_key', None)
        self.p2p_model_name = getattr(server_cfg, 'p2p_model_name', None)
    
    def _check_server_health(self) -> bool:
        """Check if server is healthy"""
        try:
            base_url = self.url.rsplit('/run', 1)[0]
            response = httpx.get(f"{base_url}/", timeout=5)
            return response.status_code == 200
        except:
            return False
    
    def wait_for_model_ready(self, max_retries=60, retry_delay=10):
        """Wait for P2P model to be fully loaded and ready.
        
        This is needed because P2P models are downloaded from Hyperdrive on first request,
        which can take several minutes. This method polls the server until the model is ready.
        """
        if not (self.hyperdrive_key and self.p2p_model_name):
            return True  # Not a P2P model, no need to wait
        
        base_url = self.url.rsplit('/run', 1)[0]
        logger.info(f"Waiting for P2P model to load from hyperdrive...")
        logger.info(f"   Model: {self.p2p_model_name}")
        logger.info(f"   This may take several minutes for large models...")
        
        for i in range(max_retries):
            try:
                # First check if server is healthy
                health_response = httpx.get(f"{base_url}/", timeout=5)
                if health_response.status_code != 200:
                    logger.debug(f"Server not healthy, retrying... ({i+1}/{max_retries})")
                    time.sleep(retry_delay)
                    continue
                
                # Try a simple test request to see if model is ready
                model_config = self.server_cfg.get_model_config()
                model_config["hyperdriveKey"] = self.hyperdrive_key
                model_config["modelName"] = self.p2p_model_name
                
                test_payload = {
                    "inputs": ["test"],
                    "config": model_config
                }
                
                response = httpx.post(self.url, json=test_payload, timeout=60)
                
                if response.status_code == 200:
                    logger.info("P2P model is ready!")
                    return True
                    
                elif response.status_code == 500:
                    # Check if it's a "model loading" error vs a real failure
                    try:
                        error_data = response.json()
                        error_msg = error_data.get('error', {}).get('message', '')
                        
                        # These are temporary errors during model loading
                        loading_errors = [
                            'CONNECTION_FAILED',
                            'Failed to connect to Hyperdrive',
                            'Corestore is closed',
                            'Hyperdrive is not ready',
                            'DRIVE_NOT_READY'
                        ]
                        
                        is_loading = any(err in str(error_msg) for err in loading_errors)
                        
                        if is_loading:
                            elapsed = (i + 1) * retry_delay
                            logger.info(f"Model downloading from hyperdrive... ({elapsed}s elapsed, attempt {i+1}/{max_retries})")
                        else:
                            logger.warning(f"Server error: {error_msg} (attempt {i+1}/{max_retries})")
                    except:
                        logger.info(f"Model loading... (attempt {i+1}/{max_retries})")
                    
                    time.sleep(retry_delay)
                    continue
                    
                else:
                    logger.warning(f"Unexpected response {response.status_code} (attempt {i+1}/{max_retries})")
                    time.sleep(retry_delay)
                    
            except httpx.TimeoutException:
                logger.info(f"Request timeout, model still loading... (attempt {i+1}/{max_retries})")
                time.sleep(retry_delay)
            except Exception as e:
                logger.debug(f"Waiting for model... (attempt {i+1}/{max_retries}): {str(e)}")
                time.sleep(retry_delay)
        
        raise Exception(f"P2P model failed to load within timeout ({max_retries * retry_delay}s)")
    
    def embed(self, sentences: list[str]) -> np.ndarray:
        """
        Generate embeddings for a list of sentences.
        
        Args:
            sentences: List of strings to embed
            
        Returns:
            numpy array of embeddings with shape (n_sentences, embedding_dim)
        """
        if not self._check_server_health():
            raise ConnectionError("Server not healthy")
        
        # Build config for the request
        model_config = self.server_cfg.get_model_config()
        
        # Check if this is a P2P model request
        is_p2p_model = self.hyperdrive_key and self.p2p_model_name
        
        if is_p2p_model:
            # P2P model - add hyperdriveKey to config
            model_config["hyperdriveKey"] = self.hyperdrive_key
            model_config["modelName"] = self.p2p_model_name
        else:
            # Local GGUF model - add diskPath to config
            if hasattr(self.server_cfg, 'selected_model'):
                model_config['modelName'] = self.server_cfg.selected_model.get('name')
                # Convert diskPath to absolute path (server runs from different directory)
                disk_path = self.server_cfg.selected_model.get('diskPath', './models/')
                model_config['diskPath'] = os.path.abspath(disk_path)
        
        payload = {
            "inputs": sentences,
            "config": model_config
        }
        
        try:
            response = self.client.post(self.url, json=payload, timeout=self.timeout)
            response.raise_for_status()
            result = response.json()
            
            data = result.get("data", {})
            outputs = data.get("outputs", [])
            
            if not outputs:
                raise ValueError("No embeddings returned from server")
            
            return np.array(outputs, dtype=np.float32)
            
        except httpx.TimeoutException:
            logger.error(f"Request timed out after {self.timeout} seconds")
            raise
        except Exception as e:
            logger.error(f"Error generating embeddings: {e}")
            raise
    
    def close(self):
        """Close the HTTP client"""
        self.client.close()


class SentenceTransformersHandler:
    """Handler for sentence-transformers library (for comparative evaluation)"""
    
    def __init__(self, model_name: str, device: str = None, dtype: str = None):
        """
        Initialize SentenceTransformers handler.
        
        Args:
            model_name: HuggingFace model name (e.g., "thenlper/gte-large")
                        Can include :F16/:F32 suffix which will be parsed if dtype not provided
            device: Device to use (cpu, cuda, mps, gpu)
            dtype: Explicit dtype ("float16", "float32", "bfloat16")
                   If provided, overrides any suffix in model_name
        """
        import torch
        
        # Parse dtype from model name if not explicitly provided
        if dtype is None:
            model_name, dtype = parse_dtype_suffix(model_name)
        
        self.model_name = model_name
        self.dtype_str = dtype
        
        # Determine device
        if device is None or device == 'gpu':
            if torch.cuda.is_available():
                device = 'cuda'
            elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                device = 'mps'
            else:
                device = 'cpu'
        
        self.device = device
        
        # Determine torch_dtype
        if self.dtype_str:
            # Explicit dtype provided or parsed from model name
            torch_dtype = getattr(torch, self.dtype_str)
            logger.info(f"Loading SentenceTransformer model: {model_name} on {device} with {self.dtype_str}")
        else:
            # Auto-detect based on device when no dtype specified
            if device == 'cuda':
                torch_dtype = torch.float16
                self.dtype_str = "float16"
            else:  # cpu, mps
                torch_dtype = torch.float32
                self.dtype_str = "float32"
            logger.info(f"Loading SentenceTransformer model: {model_name} on {device} (auto: {self.dtype_str})")
        
        self.model = SentenceTransformer(
            model_name, 
            device=device,
            model_kwargs={"dtype": torch_dtype}
        )
        self.model_name = model_name  # Store the clean model name (without dtype suffix)
        logger.info(f"SentenceTransformer model loaded successfully")
    
    def embed(self, sentences: list[str]) -> np.ndarray:
        """
        Generate embeddings for a list of sentences.
        
        Args:
            sentences: List of strings to embed
            
        Returns:
            numpy array of embeddings with shape (n_sentences, embedding_dim)
        """
        embeddings = self.model.encode(
            sentences,
            convert_to_numpy=True,
            show_progress_bar=False
        )
        return embeddings.astype(np.float32)
    
    def close(self):
        """Clean up resources"""
        pass  # SentenceTransformer doesn't need explicit cleanup


class MockModelCardData:
    """Mock model card data for MTEB metadata extraction."""
    def __init__(self, model_name: str = "thenlper/gte-large"):
        # Use a real HuggingFace model name so MTEB can find it
        self.model_name = model_name
        self.model_id = model_name
        self.base_model = model_name
        self.base_model_revision = None
        # MTEB ModelMeta expects ISO 639-3 codes with script (e.g., "eng-Latn")
        # Using proper format to avoid validation errors
        self.language = ["eng-Latn"]
        self.languages = ["eng-Latn"]
        self.license = "Apache-2.0"
        self.tags = ["sentence-transformers", "embedding"]


class MTEBModelWrapper(SentenceTransformer):
    """
    Wrapper to make QvacEmbedHandler compatible with MTEB.
    
    Inherits from SentenceTransformer so MTEB's deprecated evaluator wraps it
    in SentenceTransformerEncoderWrapper, which handles all the protocol complexity.
    """
    
    # Default embedding dimension (GTE-large = 1024)
    _embedding_dim: int = 1024
    _max_seq_length: int = 512
    
    def __init__(self, handler, batch_size: int = 32, embedding_dim: int = 1024, max_seq_length: int = 512):
        """
        Initialize MTEB wrapper.
        
        Args:
            handler: QvacEmbedHandler or SentenceTransformersHandler
            batch_size: Batch size for encoding
            embedding_dim: Embedding dimension (default 1024 for GTE-large)
            max_seq_length: Maximum sequence length for truncation (default 512)
        """
        # Initialize torch.nn.Module base only (not full SentenceTransformer)
        # Required for MTEB's internal access to PyTorch attributes
        import torch
        torch.nn.Module.__init__(self)
        
        self.handler = handler
        self._batch_size = batch_size
        self._embedding_dim = embedding_dim
        self._max_seq_length = max_seq_length
        
        # Required by SentenceTransformer interface
        self.model_name_or_path = "thenlper/gte-large"
        self.similarity_fn_name = "cosine"
        self.prompts = {}
        self.default_prompt_name = None
        self.truncate_dim = None
        self._model_card_vars = {}
        
        # Required for MTEB metadata extraction
        self.model_card_data = MockModelCardData(self.model_name_or_path)
    
    @property
    def max_seq_length(self) -> int:
        """Max sequence length - override to avoid SentenceTransformer's property."""
        return self._max_seq_length
    
    @max_seq_length.setter
    def max_seq_length(self, value: int):
        """Set max sequence length."""
        self._max_seq_length = value
    
    def get_sentence_embedding_dimension(self) -> int:
        """Return embedding dimension. Required by MTEB."""
        return self._embedding_dim
    
    def _truncate_text(self, text: str, max_tokens: int = None) -> str:
        """
        Truncate text to fit within the model's context window.
        
        Uses fast character-based truncation to avoid double tokenization
        (the C++ addon tokenizes internally). Conservative estimate ensures
        we don't exceed limits while avoiding expensive Python tokenization.
        """
        if max_tokens is None:
            max_tokens = self._max_seq_length
        
        # Reserve 2 tokens for [CLS] and [SEP]
        effective_max = max_tokens - 2
        
        # Character-based truncation: ~2.5 chars per token handles scientific/medical
        # texts with numbers, punctuation, and short words
        # This avoids tokenizing in Python (addon tokenizes again in C++)
        max_chars = int(effective_max * 2.5)
        
        if len(text) > max_chars:
            return text[:max_chars]
        return text
    
    def encode(
        self,
        sentences,
        batch_size: int = None,
        show_progress_bar: bool = None,
        output_value: str = None,
        convert_to_numpy: bool = True,
        convert_to_tensor: bool = False,
        device: str = None,
        normalize_embeddings: bool = False,
        **kwargs
    ) -> np.ndarray:
        """
        Encode sentences using the underlying handler.
        Matches SentenceTransformer.encode() signature.
        """
        import time
        import sys
        
        if isinstance(sentences, str):
            sentences = [sentences]
        
        # Truncate sentences to fit within model's context window
        sentences = [self._truncate_text(s) for s in sentences]
        
        effective_batch_size = batch_size if batch_size is not None else self._batch_size
        all_embeddings = []
        total_sentences = len(sentences)
        total_batches = (total_sentences + effective_batch_size - 1) // effective_batch_size
        
        # Progress tracking
        start_time = time.time()
        last_progress_time = start_time
        progress_interval = 10  # Print progress every 10 seconds
        
        for batch_idx, i in enumerate(range(0, len(sentences), effective_batch_size)):
            batch = sentences[i:i + effective_batch_size]
            embeddings = self.handler.embed(batch)
            all_embeddings.append(embeddings)
            
            # Progress feedback (every N seconds or at milestones)
            current_time = time.time()
            sentences_done = min(i + len(batch), total_sentences)
            
            if current_time - last_progress_time >= progress_interval or batch_idx == total_batches - 1:
                elapsed = current_time - start_time
                sentences_per_sec = sentences_done / elapsed if elapsed > 0 else 0
                remaining_sentences = total_sentences - sentences_done
                eta_seconds = remaining_sentences / sentences_per_sec if sentences_per_sec > 0 else 0
                
                # Format ETA
                if eta_seconds > 60:
                    eta_str = f"{eta_seconds / 60:.1f}m"
                else:
                    eta_str = f"{eta_seconds:.0f}s"
                
                progress_pct = (sentences_done / total_sentences) * 100
                
                # Print progress (flush immediately)
                progress_msg = f"Encoding: {sentences_done}/{total_sentences} ({progress_pct:.1f}%) | {sentences_per_sec:.1f} sent/s | ETA: {eta_str}"
                print(f"\r{progress_msg}", end="", flush=True)
                last_progress_time = current_time
        
        # Final newline after progress
        if total_sentences > effective_batch_size:
            elapsed_total = time.time() - start_time
            final_rate = total_sentences / elapsed_total if elapsed_total > 0 else 0
            print(f"\nCompleted {total_sentences} sentences in {elapsed_total:.1f}s ({final_rate:.1f} sent/s)")
        
        result = np.vstack(all_embeddings)
        
        if normalize_embeddings:
            norms = np.linalg.norm(result, axis=1, keepdims=True)
            result = result / np.where(norms > 0, norms, 1)
        
        return result
    
    def close(self):
        """Close the underlying handler."""
        self.handler.close()
