# utils.py - Utility functions for embeddings benchmark

from typing import Any
import logging
import random
import mteb
import numpy as np

logger = logging.getLogger(__name__)

# Available MTEB retrieval datasets for embeddings benchmarking
AVAILABLE_DATASETS = [
    'ArguAna',      # Argument retrieval
    'NFCorpus',     # Medical/scientific retrieval
    'SciFact',      # Scientific fact verification
    'TRECCOVID',    # COVID-19 scientific literature
    'SCIDOCS',      # Scientific document similarity
    'FiQA2018',     # Financial opinion mining
]


def get_available_datasets() -> list[str]:
    """Get list of available MTEB datasets for benchmarking"""
    return AVAILABLE_DATASETS.copy()


def subsample_retrieval_task(task, num_samples: int, seed: int = 42) -> None:
    """
    Subsample queries from a retrieval task in-place.
    
    This modifies the task's dataset to only include a subset of queries,
    while keeping the full corpus (required for meaningful retrieval evaluation).
    
    Args:
        task: MTEB retrieval task object (must have load_data() called first)
        num_samples: Number of queries to sample
        seed: Random seed for reproducibility
    """
    if not task.data_loaded:
        task.load_data()
    
    random.seed(seed)
    
    # Iterate over all subsets and splits
    for subset_key in list(task.dataset.keys()):
        for split_key in list(task.dataset[subset_key].keys()):
            split_data = task.dataset[subset_key][split_key]
            
            if 'queries' not in split_data or 'relevant_docs' not in split_data:
                continue
            
            queries = split_data['queries']
            relevant_docs = split_data['relevant_docs']
            
            # Get current number of queries
            current_count = len(queries)
            if current_count <= num_samples:
                logger.info(f"Task {task.metadata.name} [{subset_key}/{split_key}]: "
                           f"requested {num_samples} samples but only {current_count} available, using all")
                continue
            
            # Sample query indices
            sampled_indices = sorted(random.sample(range(current_count), num_samples))
            
            # Get the query IDs for sampled queries
            sampled_query_ids = set()
            for idx in sampled_indices:
                query_id = queries[idx]['id']
                sampled_query_ids.add(str(query_id))
            
            # Subsample queries dataset
            subsampled_queries = queries.select(sampled_indices)
            
            # Filter relevant_docs to only include sampled queries
            subsampled_relevant_docs = {
                qid: docs for qid, docs in relevant_docs.items()
                if str(qid) in sampled_query_ids
            }
            
            # Update the task's dataset in-place
            split_data['queries'] = subsampled_queries
            split_data['relevant_docs'] = subsampled_relevant_docs
            
            logger.info(f"Task {task.metadata.name} [{subset_key}/{split_key}]: "
                       f"subsampled from {current_count} to {num_samples} queries")


def load_mteb_tasks(dataset_names: list[str], num_samples: int | None = None) -> list:
    """
    Load MTEB tasks by dataset names, optionally with query subsampling.
    
    Args:
        dataset_names: List of dataset names to load
        num_samples: Optional number of queries to sample per dataset
        
    Returns:
        List of MTEB task objects (with data loaded and optionally subsampled)
    """
    # Validate dataset names
    invalid_datasets = [d for d in dataset_names if d not in AVAILABLE_DATASETS]
    if invalid_datasets:
        logger.warning(f"Unknown datasets (will try to load anyway): {invalid_datasets}")
    
    try:
        tasks = mteb.get_tasks(tasks=dataset_names)
        logger.info(f"Loaded {len(tasks)} MTEB tasks: {[t.metadata.name for t in tasks]}")
        
        # Load data and apply subsampling if requested
        for task in tasks:
            task.load_data()
            if num_samples is not None:
                subsample_retrieval_task(task, num_samples)
        
        return tasks
    except Exception as e:
        logger.error(f"Failed to load MTEB tasks: {e}")
        raise


def run_mteb_evaluation(model, dataset_names: list[str], batch_size: int = 32,
                       num_samples: int | None = None,
                       prediction_folder: str | None = None) -> 'mteb.ModelResult':
    """
    Run MTEB evaluation on specified datasets using mteb.evaluate().
    
    Args:
        model: Model implementing MTEB's Encoder interface (e.g., MTEBModelWrapper)
        dataset_names: List of dataset names to evaluate
        batch_size: Batch size for encoding
        num_samples: Optional number of queries to sample per dataset
        prediction_folder: Optional folder to save raw MTEB results
        
    Returns:
        ModelResult with evaluation results
    """
    tasks = load_mteb_tasks(dataset_names, num_samples=num_samples)
    
    results = mteb.evaluate(
        model=model,
        tasks=tasks,
        encode_kwargs={"batch_size": batch_size},
        raise_error=True,
        show_progress_bar=True,
        cache=None,  # Disable MTEB cache - wrapper model name doesn't reflect actual config
        prediction_folder=prediction_folder
    )
    
    return results


def compute_retrieval_metrics(query_embeddings: np.ndarray, 
                             corpus_embeddings: np.ndarray,
                             relevant_docs: dict[str, list[str]],
                             k: int = 10) -> dict[str, float]:
    """
    Compute retrieval metrics (nDCG, MRR, Recall, Precision) at k.
    
    Args:
        query_embeddings: Embeddings for queries
        corpus_embeddings: Embeddings for corpus documents
        relevant_docs: Mapping from query_id to list of relevant doc_ids
        k: Cutoff for metrics
        
    Returns:
        Dictionary with metric names and values
    """
    # Compute similarities
    similarities = np.dot(query_embeddings, corpus_embeddings.T)
    
    # Get top-k indices for each query
    top_k_indices = np.argsort(-similarities, axis=1)[:, :k]
    
    ndcg_scores = []
    mrr_scores = []
    recall_scores = []
    precision_scores = []
    
    for i, (query_id, rel_docs) in enumerate(relevant_docs.items()):
        if i >= len(top_k_indices):
            break
            
        retrieved = top_k_indices[i]
        
        # Binary relevance for this query
        relevance = [1 if str(doc_id) in rel_docs else 0 for doc_id in retrieved]
        
        # nDCG@k
        dcg = sum(rel / np.log2(pos + 2) for pos, rel in enumerate(relevance))
        ideal_rel = sorted(relevance, reverse=True)
        idcg = sum(rel / np.log2(pos + 2) for pos, rel in enumerate(ideal_rel))
        ndcg = dcg / idcg if idcg > 0 else 0
        ndcg_scores.append(ndcg)
        
        # MRR@k (reciprocal rank of first relevant document)
        for pos, rel in enumerate(relevance):
            if rel == 1:
                mrr_scores.append(1 / (pos + 1))
                break
        else:
            mrr_scores.append(0)
        
        # Recall@k
        num_relevant_retrieved = sum(relevance)
        total_relevant = len(rel_docs)
        recall = num_relevant_retrieved / total_relevant if total_relevant > 0 else 0
        recall_scores.append(recall)
        
        # Precision@k
        precision = num_relevant_retrieved / k
        precision_scores.append(precision)
    
    return {
        f'ndcg_at_{k}': np.mean(ndcg_scores) if ndcg_scores else 0,
        f'mrr_at_{k}': np.mean(mrr_scores) if mrr_scores else 0,
        f'recall_at_{k}': np.mean(recall_scores) if recall_scores else 0,
        f'precision_at_{k}': np.mean(precision_scores) if precision_scores else 0
    }


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """
    Compute cosine similarity between two vectors.
    
    Args:
        a: First vector
        b: Second vector
        
    Returns:
        Cosine similarity score
    """
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8)


def batch_cosine_similarity(queries: np.ndarray, corpus: np.ndarray) -> np.ndarray:
    """
    Compute cosine similarities between queries and corpus.
    
    Args:
        queries: Query embeddings (n_queries, dim)
        corpus: Corpus embeddings (n_docs, dim)
        
    Returns:
        Similarity matrix (n_queries, n_docs)
    """
    # Normalize embeddings
    queries_norm = queries / (np.linalg.norm(queries, axis=1, keepdims=True) + 1e-8)
    corpus_norm = corpus / (np.linalg.norm(corpus, axis=1, keepdims=True) + 1e-8)
    
    return np.dot(queries_norm, corpus_norm.T)
