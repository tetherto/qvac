import numpy as np
from typing import Any

from mteb.encoder_interface import Encoder, PromptType
from .client import EmbeddingsClient
from .config import Config, ServerConfig


class EmbeddingsModel(Encoder):
    """
    Custom embeddings model that implements MTEB's Encoder interface.

    This class wraps the existing EmbeddingsClient to provide embeddings
    through the MTEB-compatible interface for benchmarking and evaluation.
    """

    def __init__(
        self,
        server_config: ServerConfig,
        device: str | None = None,
        max_retries: int = 5,
        base_delay: float = 2.0,
    ):
        """
        Initialize the CustomModel.

        Args:
            device: The device to use for encoding (ignored for API-based models)
            server_config: Configuration for the embeddings server
            max_retries: Maximum number of retry attempts for failed requests
            base_delay: Base delay for exponential backoff (in seconds)
        """
        self.device = device
        self.server_config = server_config
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.client = None

    def _ensure_client(self) -> EmbeddingsClient:
        """Ensure the client is initialized."""
        if self.client is None:
            self.client = EmbeddingsClient(
                self.server_config,
                max_retries=self.max_retries,
                base_delay=self.base_delay,
            )
        return self.client

    def encode(
        self,
        sentences: list[str],
        *,
        task_name: str,
        prompt_type: PromptType | None = None,
        **kwargs: Any,
    ) -> np.ndarray:
        """
        Encodes the given sentences using the embeddings server.

        Args:
            sentences: The sentences to encode
            task_name: The name of the task
            prompt_type: The type of prompt
            **kwargs: Additional arguments

        Returns:
            numpy.ndarray: The encoded sentences as a 2D array
        """
        if not sentences:
            return np.array([])

        sentences_list = list(sentences)
        client = self._ensure_client()

        try:
            result = client.embed(sentences_list)
            embeddings_array = np.array(result.embeddings, dtype=np.float32)
            return embeddings_array
        except Exception as e:
            import logging

            logging.error(f"Failed to encode {len(sentences_list)} sentences: {e}")
            raise e

    def close(self) -> None:
        """Close the underlying client connection."""
        if self.client is not None:
            self.client.close()
            self.client = None

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.close()


if __name__ == "__main__":
    cfg = Config.from_yaml()
    model = EmbeddingsModel(cfg.server, max_retries=5, base_delay=2.0)

    sentences = [
        "Hello, world!",
        "This is a test sentence.",
        "Another example sentence for testing.",
    ]

    try:
        # Encode the sentences
        embeddings = model.encode(
            sentences, task_name="classification", prompt_type=PromptType.query
        )

        print(
            f"Encoded {len(sentences)} sentences into embeddings of shape: {embeddings.shape}"
        )
        print(f"Embedding dimension: {embeddings.shape[1]}")

    finally:
        # Clean up
        model.close()
