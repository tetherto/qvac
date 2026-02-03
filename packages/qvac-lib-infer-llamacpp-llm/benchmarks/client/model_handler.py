import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, logging as transformers_logging
from huggingface_hub import login
import logging
import httpx
import subprocess
import time
import os
import signal
import psutil
from datetime import datetime
import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import yaml
from typing import List, Dict, Any

logger = logging.getLogger(__name__)


class ServerConfig:
    def __init__(self, 
                 lib,
                 url: str = "http://localhost:8080/run",
                 timeout: int = 100,
                 server_dir: str = None,
                 log_dir: str = "logs",
                 response_timeout: int = 600,
                 config_path: str = None,
                 hyperdrive_key: str = None,
                 p2p_model_name: str = None,
                 p2p_model_config: dict = None):
        
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
        print(f"Testing addon: {lib}")
        self.url = url
        self.lib = lib
        self.timeout = timeout
        self.server_dir = server_dir
        self.log_dir = log_dir
        self.response_timeout = response_timeout
        self.temperature = 0.7
        self.top_p = 0.9
        self.context_window_size = 8000
        self.prefill_chunk_size = 1024
        self.max_tokens = 500
        
        # P2P model parameters
        self.hyperdrive_key = hyperdrive_key
        self.p2p_model_name = p2p_model_name
        self.p2p_model_config = p2p_model_config
        
        # Set default config path if not provided
        if config_path is None:
            # Try to find config.yaml relative to current location
            current_dir = os.getcwd()
            if os.path.basename(current_dir) == 'client':
                config_path = os.path.join(current_dir, 'config.yaml')
            elif os.path.exists(os.path.join(current_dir, 'benchmarks', 'client', 'config.yaml')):
                config_path = os.path.join(current_dir, 'benchmarks', 'client', 'config.yaml')
            else:
                config_path = os.path.join(current_dir, 'config.yaml')
        
        if config_path and os.path.exists(config_path):
            self.load_config(config_path)
        else:
            # Set default benchmark configuration
            self.benchmark_config = {
                'datasets': ['squad', 'arc', 'mmlu', 'gsm8k'],
                'num_samples': 10
            }
    
    def load_config(self, config_path: str) -> None:
        """Load configuration from YAML file"""
        try:
            with open(config_path, 'r') as f:
                config = yaml.safe_load(f)
            
            if 'server' in config:
                server_config = config['server']
                self.temperature = server_config.get('temperature', self.temperature)
                self.top_p = server_config.get('top_p', self.top_p)
                self.context_window_size = server_config.get('context_window_size', self.context_window_size)
                self.prefill_chunk_size = server_config.get('prefill_chunk_size', self.prefill_chunk_size)
                self.max_tokens = server_config.get('max_tokens', self.max_tokens)
                self.lib = server_config.get('lib', self.lib)
                
            if 'benchmark' in config:
                self.benchmark_config = config['benchmark']
            else:
                self.benchmark_config = {
                    'num_samples': 10,
                    'datasets': ['gsm8k']
                }
                
            # Load model_config from YAML if not provided directly
            if self.p2p_model_config is None and 'model_config' in config:
                self.p2p_model_config = config['model_config']
                
        except Exception as e:
            print(f"Error loading config: {e}")
            # Keep default values if config loading fails
    
    def get_benchmark_config(self) -> Dict[str, Any]:
        """Get benchmark configuration"""
        return self.benchmark_config
    
    def get_enabled_datasets(self) -> List[str]:
        """Get list of enabled datasets"""
        return self.benchmark_config.get('datasets', ['gsm8k'])
    
    def get_num_samples(self) -> int:
        """Get number of samples for benchmark"""
        return self.benchmark_config.get('num_samples', 10)

class QvacModelHandler:
    def __init__(self, server_cfg: ServerConfig):
        self.url = str(server_cfg.url)
        self.lib = server_cfg.lib
        self.timeout = server_cfg.timeout
        self.server_dir = server_cfg.server_dir
        self.log_dir = server_cfg.log_dir
        self.response_timeout = server_cfg.response_timeout
        self.client = httpx.Client(timeout=self.timeout)
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model_name = self.lib
        self.server_process = None
        self.executor = ThreadPoolExecutor(max_workers=1)
        
        # P2P model parameters
        self.hyperdrive_key = getattr(server_cfg, 'hyperdrive_key', None)
        self.p2p_model_name = getattr(server_cfg, 'p2p_model_name', None)
        self.p2p_model_config = getattr(server_cfg, 'p2p_model_config', None)
        # Create log directory if it doesn't exist
        os.makedirs(self.log_dir, exist_ok=True)
        
        self.start_server()

    def start_server(self):
        """Start the server process"""
        if self.server_process is not None:
            self.stop_server()
        
        try:
            # Create timestamp for log files
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            stdout_log = os.path.join(self.log_dir, f"server_stdout_{timestamp}.log")
            stderr_log = os.path.join(self.log_dir, f"server_stderr_{timestamp}.log")
            
            # Open log files
            stdout_file = open(stdout_log, 'w')
            stderr_file = open(stderr_log, 'w')
            
            # Change to server directory and start the server
            os.chdir(self.server_dir)
            self.server_process = subprocess.Popen(
                ["npm", "run", "start"],
                stdout=stdout_file,
                stderr=stderr_file,
                preexec_fn=os.setsid  # Create new process group
            )
            os.chdir("../../")  # Return to original directory
            
            # Wait for 2 seconds to allow server to initialize
            #time.sleep(2)
            
            # Wait for server to start
            self._wait_for_server()
            
            logger.info(f"Server started successfully. Logs available at:\n{stdout_log}\n{stderr_log}")
        except Exception as e:
            logger.error(f"Failed to start server: {e}")
            raise

    def stop_server(self):
        """Stop the server process"""
        if self.server_process is not None:
            try:
                # Kill the entire process group
                os.killpg(os.getpgid(self.server_process.pid), signal.SIGTERM)
                self.server_process.wait(timeout=5)
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
    
    def _wait_for_model_ready(self, max_retries=30, retry_delay=10):
        """Wait for P2P model to be fully loaded and ready"""
        if not (self.hyperdrive_key and self.p2p_model_name):
            return True  # Not a P2P model, no need to wait
        
        base_url = self.url.split("/run")[0]  # Get base URL without /run
        logger.info("Waiting for P2P model to load...")
        
        for i in range(max_retries):
            try:
                # First check if server is healthy
                health_response = httpx.get(f"{base_url}/", timeout=5)
                if health_response.status_code != 200:
                    time.sleep(retry_delay)
                    continue
                
                # Try a simple test request to see if model is ready
                test_payload = {
                    "inputs": ["test"],
                    "hyperdriveKey": self.hyperdrive_key,
                    "modelName": self.p2p_model_name,
                    "modelConfig": self.p2p_model_config or {},
                    "params": {"num_return_sequences": 1},
                    "opts": {
                        "stats": True,
                        "context_window_size": 1024,
                        "prefill_chunk_size": 512,
                        "temperature": 0.7,
                        "max_tokens": 10,
                        "top_p": 0.9,
                        "do_sample": True,
                        "system_message": "You are a helpful assistant."
                    }
                }
                
                response = httpx.post(self.url, json=test_payload, timeout=30)
                if response.status_code == 200:
                    logger.info("P2P model is ready!")
                    return True
                elif response.status_code == 500:
                    # Model might still be loading, continue waiting
                    logger.info(f"Model still loading... (attempt {i+1}/{max_retries})")
                    time.sleep(retry_delay)
                    continue
                else:
                    logger.warning(f"Unexpected response: {response.status_code}")
                    time.sleep(retry_delay)
                    
            except Exception as e:
                logger.info(f"Waiting for model... (attempt {i+1}/{max_retries}): {str(e)}")
                time.sleep(retry_delay)
        
        raise Exception("P2P model failed to load within timeout")
    def _check_server_health(self):
        """Check if server is healthy"""
        try:
            base_url = self.url.split("/run")[0]
            response = httpx.get(f"{base_url}/", timeout=5)
            return response.status_code == 200
        except:
            return False

    def _make_request_with_timeout(self, json_req: Dict[str, Any]) -> str:
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
            logger.error(f"Error generating answer: {e}")
            if isinstance(e, (httpx.TimeoutException, httpx.ConnectError)):
                logger.warning("Connection error detected, restarting server")
                self.start_server()
            return ""

    def generate_answer(self, prompt: str, max_new_tokens: int = 500) -> str:
        """
        Generate an answer for the given prompt
        """
        if not self._check_server_health():
            logger.warning("Server not healthy, attempting restart")
            self.start_server()

        # Check if this is a P2P model request
        is_p2p_model = self.hyperdrive_key and self.p2p_model_name
        
        json_req = {
            "inputs": [prompt],
            "params": {
                "num_return_sequences": int(1)
            },
            "opts": {  
                "stats": True, 
                "context_window_size": 1024, 
                "prefill_chunk_size": 256, 
                "temperature": 0.7,
                "max_tokens": 50,
                "top_p": 0.9,
                "do_sample": True,
                "system_message": 'You are a helpful assistant.'
            }
        }
        
        if is_p2p_model:
            # P2P model mode
            json_req.update({
                "hyperdriveKey": self.hyperdrive_key,
                "modelName": self.p2p_model_name,
                "modelConfig": self.p2p_model_config or {}
            })
        else:
            # Pre-installed model mode
            json_req.update({
                "lib": self.lib
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
    def __init__(self, model_name, hf_token: str = None):
        """Initialize the model handler with model name and HuggingFace token"""
        if hf_token:
            login(token=hf_token)
            logger.info("Logged in to HuggingFace")
        
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Using device: {self.device}")
        self.model_name = model_name
        
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(model_name)
            self.model = AutoModelForCausalLM.from_pretrained(
                model_name,
                torch_dtype=torch.float16 if self.device == "cuda" else torch.float32,
                device_map="auto"
            )
        except Exception as e:
            logger.error(f"Error loading model: {str(e)}")
            logger.error("Please make sure you have:")
            logger.error("1. A valid HuggingFace token")
            logger.error("2. Access to the Llama model (request access at https://huggingface.co/meta-llama/Llama-3.2-1B)")
            raise

    def close(self):
        pass
    
    def generate_answer(self, prompt: str, max_new_tokens: int = 1000) -> str:
        """Generate an answer for the given prompt"""
        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.device)
        outputs = self.model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            num_return_sequences=1,
            temperature=0.6,
            do_sample=True,
            top_p=0.9
        )
        response = self.tokenizer.decode(outputs[0], skip_special_tokens=True)
        return response



if __name__ == "__main__":
    client = httpx.Client(timeout=200)
    prompt = """
Hi
    """

    json_req ={
                "inputs":[prompt],
                "lib": "@tetherto/qvac-lib-inference-addon-mlc-llama-3_2_1b-q4f16_1",
               "params": {
                "num_return_sequences": int(1)
            },
            "opts": {  
                "stats": True, 
                "context_window_size": 1024*32, 
                "prefill_chunk_size": 8096, 
                "temperature": 0.7,
                "max_tokens": 1000,
                "top_p": 0.9,
                "do_sample": True,
                "system_message": 'You are a helpful assistant.'
            }
            }
    resp = client.post(
            "http://localhost:8080/run",
            json=json_req
        )
    resp.raise_for_status()
    payload = resp.json()

    data = payload.get("data", {})
    outputs = data.get("outputs", [])
    times = data.get("time", {})
    print(outputs)

    
    