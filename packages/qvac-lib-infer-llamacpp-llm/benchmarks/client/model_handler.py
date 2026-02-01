from typing import Any
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from huggingface_hub import login, hf_hub_download, list_repo_files
import logging
import httpx
import subprocess
import time
import os
import signal
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, TimeoutError

logger = logging.getLogger(__name__)


# Default configuration values (single source of truth)
DEFAULT_CONFIG = {
    'gpu_layers': '99',
    'ctx_size': '8192',
    'temp': '0.7',
    'n_predict': '4096',
    'top_p': '0.9',
    'top_k': '40',
    'repeat_penalty': '1',
    'seed': '-1',
    'device': 'gpu'
}


def download_gguf_from_huggingface(repo_id: str, quantization: str | None = None, hf_token: str | None = None) -> str:
    """
    Download a GGUF model from HuggingFace Hub
    
    Args:
        repo_id: HuggingFace repository ID (e.g., "bartowski/Llama-3.2-1B-Instruct-GGUF")
        quantization: Specific quantization to download (e.g., "Q4_K_M", "Q8_0")
        hf_token: HuggingFace authentication token
        
    Returns:
        str: Local path to the downloaded GGUF file
    """
    logger.info(f"📥 Downloading GGUF model from HuggingFace: {repo_id}")
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
            # Try to find exact match with quantization
            quantization_upper = quantization.upper()
            for f in gguf_files:
                if quantization_upper in f.upper():
                    selected_file = f
                    break
            
            if not selected_file:
                raise ValueError(f"No GGUF file found with quantization '{quantization}' in {repo_id}. Available files: {gguf_files}")
        else:
            # No quantization specified, use the first GGUF file (or prefer Q4 variants)
            q4_files = [f for f in gguf_files if 'Q4' in f.upper()]
            if q4_files:
                selected_file = q4_files[0]
                logger.info(f"   No quantization specified, using Q4 variant: {selected_file}")
            else:
                selected_file = gguf_files[0]
                logger.info(f"   No quantization specified, using first available: {selected_file}")
        
        logger.info(f"   Selected file: {selected_file}")
        
        # Check if already downloaded
        local_filename = os.path.basename(selected_file)
        local_path = os.path.join(models_dir, local_filename)
        
        if os.path.exists(local_path):
            file_size = os.path.getsize(local_path)
            logger.info(f"   ✅ File already exists: {local_path} ({file_size / (1024**2):.1f} MB)")
            return local_path
        
        # Download the file
        logger.info(f"   ⏳ Downloading to {models_dir}...")
        downloaded_path = hf_hub_download(
            repo_id=repo_id,
            filename=selected_file,
            local_dir=models_dir,
            token=hf_token
        )
        
        file_size = os.path.getsize(downloaded_path)
        logger.info(f"   ✅ Downloaded successfully: {downloaded_path} ({file_size / (1024**2):.1f} MB)")
        
        return downloaded_path
        
    except Exception as e:
        logger.error(f"   ❌ Failed to download GGUF model: {e}")
        raise


class ServerConfig:
    def __init__(self, 
                 url: str = "http://localhost:7357/run",
                 timeout: int = 100,
                 server_dir: str = None,
                 log_dir: str = "logs",
                 response_timeout: int = 600,
                 hyperdrive_uri: str = None,
                 cli_samples: int = None,
                 cli_datasets: str = None,
                 cli_device: str = None,
                 cli_temperature: float = None,
                 cli_ctx_size: int = None,
                 cli_gpu_layers: str = None,
                 cli_top_p: float = None,
                 cli_n_predict: int = None,
                 cli_top_k: int = None,
                 cli_repeat_penalty: float = None,
                 cli_seed: int = None):
        
        # Set default server directory relative to current working directory
        if server_dir is None:
            # Try to find the server directory relative to current location
            current_dir = os.getcwd()
            if os.path.basename(current_dir) == 'client':
                server_dir = os.path.join(os.path.dirname(current_dir), 'server')
            elif os.path.exists(os.path.join(current_dir, 'benchmarks', 'server')):
                server_dir = os.path.join(current_dir, 'benchmarks', 'server')
            else:
                server_dir = os.path.join(current_dir, 'server')
        self.url = url
        self.timeout = timeout
        self.server_dir = server_dir
        self.log_dir = log_dir
        self.response_timeout = response_timeout
        
        # Model parameters from DEFAULT_CONFIG (as attributes for getattr access in comparative_evaluator)
        self.gpu_layers = DEFAULT_CONFIG['gpu_layers']  # Will be overridden by CLI or auto-set to '0' for CPU
        self.ctx_size = DEFAULT_CONFIG['ctx_size']
        self.temp = DEFAULT_CONFIG['temp']
        self.n_predict = DEFAULT_CONFIG['n_predict']
        self.top_p = DEFAULT_CONFIG['top_p']
        self.top_k = DEFAULT_CONFIG['top_k']
        self.repeat_penalty = DEFAULT_CONFIG['repeat_penalty']
        self.seed = DEFAULT_CONFIG['seed']
        
        # P2P model parameters - split URI once here
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
            'datasets': ['squad', 'arc', 'mmlu', 'gsm8k'],
            'num_samples': 10
        }
        
        # Apply CLI overrides
        self.apply_cli_overrides(cli_samples, cli_datasets, cli_device, 
                                cli_temperature, cli_ctx_size, cli_gpu_layers, cli_top_p, cli_n_predict,
                                cli_top_k, cli_repeat_penalty, cli_seed)
    
    def apply_cli_overrides(self, cli_samples: int = None, cli_datasets: str = None, cli_device: str = None,
                           cli_temperature: float = None, cli_ctx_size: int = None, cli_gpu_layers: str = None, 
                           cli_top_p: float = None, cli_n_predict: int = None, cli_top_k: int = None,
                           cli_repeat_penalty: float = None, cli_seed: int = None):
        """Apply CLI argument overrides to configuration"""
        if cli_samples is not None:
            self.benchmark_config['num_samples'] = cli_samples
            print(f"CLI override: num_samples = {cli_samples}")
        
        if cli_datasets is not None:
            # Parse comma-separated datasets
            datasets_list = [d.strip() for d in cli_datasets.split(',')]
            # Expand 'all' to all available datasets
            if 'all' in datasets_list:
                datasets_list = ['squad', 'arc', 'mmlu', 'gsm8k']
            self.benchmark_config['datasets'] = datasets_list
            print(f"CLI override: datasets = {datasets_list}")
        
        # Set device (use DEFAULT_CONFIG if not specified)
        device_to_use = cli_device if cli_device is not None else DEFAULT_CONFIG['device']
        self.device = device_to_use
        
        if cli_device is not None:
            print(f"CLI override: device = {cli_device}")
        else:
            print(f"Using default device: {device_to_use}")
        
        # Apply model parameter overrides
        if cli_temperature is not None:
            self.temp = str(cli_temperature)
            print(f"CLI override: temp = {cli_temperature}")
        
        if cli_ctx_size is not None:
            self.ctx_size = str(cli_ctx_size)
            print(f"CLI override: ctx_size = {cli_ctx_size}")
        
        # Handle gpu_layers override
        if cli_gpu_layers is not None:
            self.gpu_layers = cli_gpu_layers
            print(f"CLI override: gpu_layers = {cli_gpu_layers}")
        
        # Force gpu_layers to 0 when device is CPU
        if device_to_use == 'cpu':
            self.gpu_layers = '0'
            print(f"🔧 Auto-override: gpu_layers = 0 (CPU mode, GPU offloading disabled)")
        
        if cli_top_p is not None:
            self.top_p = str(cli_top_p)
            print(f"CLI override: top_p = {cli_top_p}")
        
        if cli_n_predict is not None:
            self.n_predict = str(cli_n_predict)
            print(f"CLI override: n_predict = {cli_n_predict}")
        
        if cli_top_k is not None:
            self.top_k = str(cli_top_k)
            print(f"CLI override: top_k = {cli_top_k}")
        
        if cli_repeat_penalty is not None:
            self.repeat_penalty = str(cli_repeat_penalty)
            print(f"CLI override: repeat_penalty = {cli_repeat_penalty}")
        
        if cli_seed is not None:
            self.seed = str(cli_seed)
            print(f"CLI override: seed = {cli_seed}")
    
    def get_enabled_datasets(self) -> list[str]:
        """Get list of enabled datasets"""
        return self.benchmark_config.get('datasets', ['squad', 'arc', 'mmlu', 'gsm8k'])
    
    def get_num_samples(self) -> int:
        """Get number of samples for benchmark"""
        return self.benchmark_config.get('num_samples', 10)
    
    def get_model_config(self) -> dict[str, str]:
        """
        Get model configuration as a dictionary suitable for sending to server
        
        Returns:
            Dictionary with all model parameters
        """
        return {
            'device': self.device,
            'gpu_layers': str(self.gpu_layers),
            'ctx_size': str(self.ctx_size),
            'temp': str(self.temp),
            'top_p': str(self.top_p),
            'top_k': str(self.top_k),
            'n_predict': str(self.n_predict),
            'repeat_penalty': str(self.repeat_penalty),
            'seed': str(self.seed)
        }

class QvacModelHandler:
    def __init__(self, server_cfg: ServerConfig):
        # Store the entire ServerConfig instance
        self.server_cfg = server_cfg
        
        self.url = str(server_cfg.url)
        self.timeout = server_cfg.timeout
        self.server_dir = server_cfg.server_dir
        self.log_dir = server_cfg.log_dir
        self.response_timeout = server_cfg.response_timeout
        self.client = httpx.Client(timeout=self.timeout)
        self.model_name = "llamacpp-addon"  # Display name for addon-based inference
        self.server_process = None
        self.executor = ThreadPoolExecutor(max_workers=1)
        
        # P2P model parameters (already split in ServerConfig)
        self.hyperdrive_key = getattr(server_cfg, 'hyperdrive_key', None)
        self.p2p_model_name = getattr(server_cfg, 'p2p_model_name', None)
        
        # Create log directory if it doesn't exist
        os.makedirs(self.log_dir, exist_ok=True)
        
        self.start_server()

    def start_server(self):
        """Start the server process"""
        if self.server_process is not None:
            self.stop_server()
        
        # Ensure log directory exists
        os.makedirs(self.log_dir, exist_ok=True)
        
        # Create timestamp for log files
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stdout_log = os.path.join(self.log_dir, f"server_stdout_{timestamp}.log")
        stderr_log = os.path.join(self.log_dir, f"server_stderr_{timestamp}.log")
        
        # Open log files - track for cleanup on failure
        stdout_file = None
        stderr_file = None
        popen_succeeded = False
        
        try:
            stdout_file = open(stdout_log, 'w', buffering=1)  # Line buffered
            stderr_file = open(stderr_log, 'w', buffering=1)  # Line buffered
            
            # Change to server directory and start the server
            os.chdir(self.server_dir)
            # Set NODE_NO_WARNINGS=1 and force unbuffered output
            env = os.environ.copy()
            env['NODE_NO_WARNINGS'] = '1'
            env['PYTHONUNBUFFERED'] = '1'
            
            self.server_process = subprocess.Popen(
                ["npm", "run", "start"],
                stdout=stdout_file,
                stderr=stderr_file,
                env=env,
                bufsize=1,  # Line buffered
                universal_newlines=True,  # Text mode
                preexec_fn=os.setsid  # Create new process group
            )
            popen_succeeded = True  # Popen now owns the file handles
            os.chdir("../../")  # Return to original directory
            
            # Wait for server to start
            self._wait_for_server()
            
            # Wait for P2P model to be ready if using P2P mode
            if self.hyperdrive_key and self.p2p_model_name:
                self._wait_for_model_ready()
            
            logger.info(f"Server started successfully. Logs available at:\n{stdout_log}\n{stderr_log}")
        except Exception as e:
            logger.error(f"Failed to start server: {e}")
            raise
        finally:
            # Only close files if Popen didn't take ownership
            if not popen_succeeded:
                if stdout_file is not None:
                    stdout_file.close()
                if stderr_file is not None:
                    stderr_file.close()

    def stop_server(self):
        """Stop the server process"""
        if self.server_process is not None:
            try:
                return_code = self.server_process.poll()
                if return_code is None:
                    # Still running, kill the entire process group
                    os.killpg(os.getpgid(self.server_process.pid), signal.SIGTERM)
                    self.server_process.wait(timeout=5)
                else:
                    logger.info(f"Server process {self.server_process.pid} already exited")
            except Exception as e:
                logger.error(f"Error stopping server: {e}")
                # Force kill if graceful shutdown fails
                try:
                    os.killpg(os.getpgid(self.server_process.pid), signal.SIGKILL)
                except:
                    pass
            finally:
                self.server_process = None

    def _wait_for_server(self, max_retries=5, retry_delay=2):
        """Wait for server to be ready by checking health endpoint"""
        base_url = self.url.split("/run")[0]  # Get base URL without /run
        for i in range(max_retries):
            try:
                response = httpx.get(f"{base_url}/", timeout=5)
                if response.status_code == 200:
                    return True
            except:
                pass
            time.sleep(retry_delay)
        raise Exception("Server failed to start within timeout")
    
    def _wait_for_model_ready(self, max_retries=60, retry_delay=10):
        """Wait for P2P model to be fully loaded and ready"""
        if not (self.hyperdrive_key and self.p2p_model_name):
            return True  # Not a P2P model, no need to wait
        
        base_url = self.url.split("/run")[0]  # Get base URL without /run
        logger.info(f"⏳ Waiting for P2P model to load from hyperdrive...")
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
                    logger.info("✅ P2P model is ready!")
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
                            logger.info(f"📦 Model downloading from hyperdrive... ({elapsed}s elapsed, attempt {i+1}/{max_retries})")
                        else:
                            logger.warning(f"⚠️  Server error: {error_msg} (attempt {i+1}/{max_retries})")
                    except:
                        logger.info(f"📦 Model loading... (attempt {i+1}/{max_retries})")
                    
                    time.sleep(retry_delay)
                    continue
                    
                else:
                    logger.warning(f"Unexpected response {response.status_code} (attempt {i+1}/{max_retries})")
                    time.sleep(retry_delay)
                    
            except httpx.TimeoutException:
                logger.info(f"⏱️  Request timeout, model still loading... (attempt {i+1}/{max_retries})")
                time.sleep(retry_delay)
            except Exception as e:
                logger.debug(f"Waiting for model... (attempt {i+1}/{max_retries}): {str(e)}")
                time.sleep(retry_delay)
        
        raise Exception(f"❌ P2P model failed to load within timeout ({max_retries * retry_delay}s)")

    def _check_server_health(self):
        """Check if server is healthy"""
        try:
            base_url = self.url.split("/run")[0]
            response = httpx.get(f"{base_url}/", timeout=5)
            return response.status_code == 200
        except:
            return False

    def _make_request_with_timeout(self, json_req: dict[str, Any]) -> str:
        """Make request with timeout using ThreadPoolExecutor"""
        try:
            future = self.executor.submit(
                self.client.post,
                self.url,
                json=json_req,
                timeout=self.response_timeout
            )
            resp = future.result(timeout=self.response_timeout)
            resp.raise_for_status()
            payload = resp.json()

            data = payload.get("data", {})
            outputs = data.get("outputs", [])
            times = data.get("time", {})
            
            return outputs[0] if outputs else ""
        except TimeoutError:
            logger.error(f"Request timed out after {self.response_timeout} seconds")
            # Restart server on timeout
            self.start_server()
            return ""
        except Exception as e:
            error_type = type(e).__name__
            logger.error(f"Error generating answer ({error_type}): {e}")
            
            # Check if it's a connection/server error that requires restart
            if isinstance(e, (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError)):
                logger.warning(f"Server connection error detected ({error_type}), attempting restart")
                logger.warning("💡 Check server logs for crash details - see logs/server_stderr_*.log")
                try:
                    self.start_server()
                except Exception as restart_error:
                    logger.error(f"Failed to restart server: {restart_error}")
            return ""

    def generate_answer(self, prompt: str, system_prompt: str = None) -> str:
        """
        Generate an answer for the given prompt.
        Note: max tokens is controlled by n_predict config sent to server, not a function parameter.
        
        Args:
            prompt: The user's input prompt
            system_prompt: Optional system prompt to guide model behavior
        """
        if not self._check_server_health():
            logger.warning("Server not healthy, attempting restart")
            self.start_server()

        # Build request with unified structure
        json_req = {
            "inputs": [prompt]
        }
        
        # Add system prompt if provided
        if system_prompt:
            json_req["systemPrompt"] = system_prompt
        
        # Build unified config for both P2P and local models
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
                selected_model = self.server_cfg.selected_model
                model_config["modelName"] = selected_model.get('name')
                model_config["diskPath"] = selected_model.get('diskPath', './models/')
        
        json_req.update({
            "config": model_config
        })
        
        return self._make_request_with_timeout(json_req)

    def close(self) -> None:
        """
        Close the underlying HTTP client and stop the server.
        """
        self.client.close()
        self.stop_server()
        self.executor.shutdown(wait=True)


class ModelHandler:
    def __init__(self, server_cfg: ServerConfig):
        """
        Initialize the model handler with ServerConfig
        
        Args:
            server_cfg: ServerConfig with model name, HF token, and all parameters
        """
        # Store config for parameter access
        self.config = server_cfg
        
        # Extract model name and token from config
        model_name = getattr(server_cfg, 'transformers_model_name', None)
        if not model_name:
            raise ValueError("transformers_model_name must be set in ServerConfig for ModelHandler")
        
        hf_token = getattr(server_cfg, 'hf_token', None)
        
        if hf_token:
            try:
                login(token=hf_token)
                logger.info("Logged in to HuggingFace")
            except Exception as e:
                logger.warning(f"HuggingFace login failed: {e}. Proceeding without authentication for public models.")
        else:
            logger.info("No HuggingFace token provided. Using public models only.")
        
        # Map device parameter to PyTorch device (default to 'gpu' if not specified)
        device = getattr(server_cfg, 'device', DEFAULT_CONFIG['device'])
        device_lower = device.lower()
        
        if device_lower == 'gpu':
            # "gpu" means use best available GPU
            if torch.cuda.is_available():
                self.device = "cuda"
                logger.info("Using GPU: CUDA (NVIDIA)")
            elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                self.device = "mps"
                logger.info("Using GPU: MPS (Apple Silicon)")
            else:
                logger.warning("GPU requested but none available, falling back to CPU")
                self.device = "cpu"
        else:
            # Direct device specification: cpu, cuda, mps
            self.device = device_lower
        
        logger.info(f"Transformers using device: {self.device}")
        self.model_name = model_name
        
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(model_name, token=hf_token)
            
            # Configure model loading based on device
            if self.device == "cpu":
                # CPU configuration
                self.model = AutoModelForCausalLM.from_pretrained(
                    model_name,
                    torch_dtype=torch.float32,
                    device_map={"": "cpu"},
                    token=hf_token
                )
            elif self.device == "cuda":
                # CUDA configuration (NVIDIA GPU)
                self.model = AutoModelForCausalLM.from_pretrained(
                    model_name,
                    torch_dtype=torch.float16,  # Use float16 for GPU efficiency
                    device_map={"": "cuda"},
                    token=hf_token
                )
            elif self.device == "mps":
                # Apple Silicon GPU (Metal Performance Shaders)
                logger.info("Using MPS (Apple Silicon GPU) - may have compatibility issues with some models")
                self.model = AutoModelForCausalLM.from_pretrained(
                    model_name,
                    torch_dtype=torch.float32,  # MPS works better with float32
                    device_map={"": "mps"},
                    token=hf_token
                )
            else:
                # Unknown device - fallback to CPU
                logger.warning(f"Unknown device '{self.device}', using CPU instead")
                self.device = "cpu"
                self.model = AutoModelForCausalLM.from_pretrained(
                    model_name,
                    torch_dtype=torch.float32,
                    device_map={"": "cpu"},
                    token=hf_token
                )
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error loading model: {error_msg}")
            
            # Provide specific guidance for gated models (403 errors)
            if "403" in error_msg or "gated" in error_msg.lower():
                logger.error("=" * 80)
                logger.error("🔒 GATED MODEL ACCESS REQUIRED")
                logger.error("=" * 80)
                logger.error(f"The model '{model_name}' is a gated model that requires:")
                logger.error("")
                logger.error(f"1. Accept the license at: https://huggingface.co/{model_name}")
                logger.error("2. Generate a token at: https://huggingface.co/settings/tokens")
                logger.error("3. Use the token with: --hf-token YOUR_TOKEN")
                logger.error("")
                logger.error("Steps to gain access:")
                logger.error("  a) Go to the model page and click 'Request Access'")
                logger.error("  b) Accept the license agreement")
                logger.error("  c) Wait for approval (usually instant for Llama models)")
                logger.error("  d) Use your HuggingFace token with this tool")
                logger.error("=" * 80)
            else:
                logger.error("Please make sure you have:")
                logger.error("1. A valid HuggingFace token")
                logger.error("2. Access to the model (if it's gated)")
                logger.error("3. Sufficient disk space and memory")
            raise

    def close(self):
        pass
    
    def generate_answer(self, prompt: str, system_prompt: str = None) -> str:
        """
        Generate an answer for the given prompt.
        Uses n_predict from config for max tokens to match llamacpp behavior.
        
        Args:
            prompt: The user's input prompt
            system_prompt: Optional system prompt to guide model behavior
        """
        # Get max tokens from config (n_predict) to match llamacpp
        n_predict = int(self.config.n_predict) if self.config else int(DEFAULT_CONFIG['n_predict'])
        
        # Get model's maximum context window
        # Use model's max_position_embeddings if available, otherwise use configured ctx_size
        model_max_length = getattr(self.model.config, 'max_position_embeddings', None)
        config_ctx_size = int(self.config.ctx_size) if self.config else int(DEFAULT_CONFIG['ctx_size'])
        
        # Use the minimum of model's max and configured ctx_size (to avoid exceeding model capacity)
        if model_max_length:
            max_length = min(model_max_length, config_ctx_size)
        else:
            max_length = config_ctx_size
        
        # Reserve full n_predict tokens for generation
        # If n_predict is -1 (unlimited), reserve DEFAULT_CONFIG amount
        reserved_tokens = n_predict if n_predict > 0 else int(DEFAULT_CONFIG['n_predict'])
        
        # Calculate max input size: context window - reserved tokens
        # Ensure at least 512 tokens for input, even if it means truncating output
        max_input_length = max(max_length - reserved_tokens, 1024)
        
        # Format prompt with system prompt if provided
        if system_prompt:
            # Try to use chat template if available (modern approach for instruction-tuned models)
            if hasattr(self.tokenizer, 'apply_chat_template') and self.tokenizer.chat_template:
                messages = [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt}
                ]
                try:
                    formatted_prompt = self.tokenizer.apply_chat_template(
                        messages, 
                        tokenize=False,
                        add_generation_prompt=True
                    )
                except Exception as e:
                    logger.warning(f"Chat template failed: {e}. Using manual formatting.")
                    # Fallback to manual formatting
                    formatted_prompt = f"<|system|>\n{system_prompt}\n<|user|>\n{prompt}\n<|assistant|>\n"
            else:
                # Manual formatting for models without chat template
                # This is a generic format that works with many instruction-tuned models
                formatted_prompt = f"<|system|>\n{system_prompt}\n<|user|>\n{prompt}\n<|assistant|>\n"
        else:
            formatted_prompt = prompt
        
        # Tokenize with truncation to fit within model's context window
        inputs = self.tokenizer(
            formatted_prompt, 
            return_tensors="pt",
            truncation=True,
            max_length=max_input_length
        ).to(self.device)
        
        # Log if truncation occurred
        input_length = inputs['input_ids'].shape[1]
        if input_length >= max_input_length:
            logger.warning(f"Prompt truncated from {len(formatted_prompt)} chars to {input_length} tokens (max: {max_input_length})")
        
        # Get generation parameters from config (if available) or use DEFAULT_CONFIG
        # Match the parameters used in the llamacpp model for fair comparison
        temperature = float(self.config.temp) if self.config else float(DEFAULT_CONFIG['temp'])
        top_p = float(self.config.top_p) if self.config else float(DEFAULT_CONFIG['top_p'])
        top_k = int(self.config.top_k) if self.config else int(DEFAULT_CONFIG['top_k'])
        
        # Use n_predict for max_new_tokens to match llamacpp
        # If n_predict is -1 (unlimited), use DEFAULT_CONFIG as cap
        max_new_tokens = n_predict if n_predict > 0 else int(DEFAULT_CONFIG['n_predict'])
        
        # Get repetition_penalty - HuggingFace uses this instead of presence/frequency penalty
        # Llamacpp's repeat_penalty maps to HuggingFace's repetition_penalty
        repetition_penalty = float(self.config.repeat_penalty) if self.config else float(DEFAULT_CONFIG['repeat_penalty'])
        
        # Set seed for reproducibility if provided
        # Note: seed=-1 means random in llamacpp, so we only set if seed >= 0
        seed = int(self.config.seed) if self.config else int(DEFAULT_CONFIG['seed'])
        if seed >= 0:
            torch.manual_seed(seed)
            if self.device == "cuda":
                torch.cuda.manual_seed_all(seed)
            elif self.device == "mps":
                torch.mps.manual_seed(seed)
        
        # Generate output on the same device as the model and inputs
        # Using parameters supported by both llamacpp and HuggingFace transformers:
        # temperature, top_p, top_k, max_new_tokens (from n_predict), repetition_penalty
        outputs = self.model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repetition_penalty=repetition_penalty,
            pad_token_id=self.tokenizer.eos_token_id,  # Avoid warnings
            do_sample=True  # Required for temperature/top_p/top_k to work
        )
        
        # Extract only the NEW tokens (skip the input prompt)
        # Move to CPU for decoding if on GPU/MPS
        if self.device in ["cuda", "mps"]:
            generated_tokens = outputs[0][input_length:].cpu()
        else:
            generated_tokens = outputs[0][input_length:]
        response = self.tokenizer.decode(generated_tokens, skip_special_tokens=True)
        
        return response



class ModelEvaluator:
    """
    Handler-agnostic model evaluator that works with any handler
    (QvacModelHandler or ModelHandler)
    """
    
    def __init__(self, handler, model_name: str):
        """
        Initialize the ModelEvaluator with any handler.
        
        Args:
            handler: Model handler with generate_answer(prompt, system_prompt) method
                    Can be QvacModelHandler or ModelHandler
            model_name: Display name for the model (for results)
        """
        self.handler = handler
        self.model_name = model_name
    
    def evaluate_dataset(self, dataset_name: str, prompts: list[str], 
                        ground_truths: list[str], metric_fn, 
                        system_prompt: str = None) -> tuple[list[float], int]:
        """
        Generic dataset evaluation that works with any handler
        
        Args:
            dataset_name: Name of the dataset
            prompts: List of input prompts
            ground_truths: List of correct answers
            metric_fn: Function to calculate metrics
            system_prompt: Optional system prompt
            
        Returns:
            Tuple of (scores list, error_count)
        """
        scores = []
        error_count = 0
        
        for i, (prompt, ground_truth) in enumerate(zip(prompts, ground_truths)):
            try:
                # Generate answer
                answer = self.handler.generate_answer(prompt, system_prompt=system_prompt)
                
                # Compute score
                score = metric_fn(answer, ground_truth)
                scores.append(score)
                
            except Exception as e:
                logger.error(f"Error processing sample {i+1}: {e}")
                scores.append(0.0)
                error_count += 1
        
        return scores, error_count
