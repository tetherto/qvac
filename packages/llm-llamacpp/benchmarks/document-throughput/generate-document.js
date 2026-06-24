'use strict'

const fs = require('bare-fs')
const path = require('bare-path')

const WORDS_PER_PAGE = 400
const TARGET_PAGES = 10

const SECTIONS = [
  {
    title: 'Introduction to Distributed Systems',
    paragraphs: [
      [
        'Distributed systems form the backbone of modern computing infrastructure.',
        'These systems consist of multiple independent components that communicate through message passing over a network.',
        'Unlike monolithic architectures, distributed systems spread computation and data across many nodes, enabling horizontal scalability and fault tolerance that would be impossible with a single machine.',
        'The design principles behind these systems have evolved over several decades, drawing from early research in telecommunications and fault-tolerant computing.',
        'Today, virtually every large-scale internet service relies on distributed system principles to serve billions of users with low latency and high availability.'
      ],
      [
        'The fundamental challenge in distributed systems is managing state consistency across nodes that can fail independently.',
        'The CAP theorem, formalized by Eric Brewer in 2000, establishes that a distributed system can simultaneously satisfy at most two of three guarantees: consistency, availability, and partition tolerance.',
        'Since network partitions are inevitable in practice, system designers must choose between strong consistency and high availability.',
        'This tradeoff permeates every layer of the distributed stack, from storage engines to application protocols.',
        'The PACELC extension refines this model by also considering the latency-consistency tradeoff that exists even when the network is functioning normally.'
      ],
      [
        'Modern distributed databases like Apache Cassandra and Amazon DynamoDB opt for eventual consistency to maximize availability.',
        'In contrast, systems like Google Spanner achieve external consistency through hardware-synchronized atomic clocks called TrueTime.',
        'The choice between these approaches depends entirely on application requirements.',
        'Financial transactions and inventory management demand strong consistency to prevent double-spending and overselling.',
        'Social media feeds and content recommendation systems tolerate eventual consistency because brief staleness does not degrade user experience.',
        'CockroachDB takes a middle path, using hybrid logical clocks to provide serializable isolation without requiring specialized hardware like GPS receivers or atomic oscillators.'
      ],
      [
        'Consensus protocols such as Paxos and Raft provide mechanisms for distributed nodes to agree on a single value despite arbitrary failures.',
        'The original Paxos protocol, described by Leslie Lamport, is notoriously difficult to implement correctly.',
        'Raft was designed specifically for understandability and has become the de facto standard for building replicated state machines.',
        'It separates consensus into distinct subproblems: leader election, log replication, and safety.',
        'Raft has become the foundation for distributed key-value stores like etcd, which in turn powers Kubernetes cluster coordination.',
        'The Multi-Paxos variant extends single-decree consensus to process an ordered sequence of commands across all replicas, forming the basis for systems like Google Chubby and Apache ZooKeeper.'
      ],
      [
        'Service mesh architectures like Istio and Linkerd add observability, traffic management, and security to microservice communication without requiring application code changes.',
        'Sidecar proxies such as Envoy intercept all network traffic between services.',
        'This enables fine-grained routing policies, mutual TLS authentication, circuit breaking, and distributed tracing across the entire service topology.',
        'These capabilities are essential for operating large-scale distributed systems where hundreds of microservices interact in complex dependency graphs.',
        'Without a service mesh, each development team would need to independently implement cross-cutting concerns like retry logic, timeout handling, and load balancing.'
      ]
    ]
  },
  {
    title: 'Machine Learning Model Architecture',
    paragraphs: [
      [
        'Transformer architectures have fundamentally changed natural language processing since their introduction in the landmark paper "Attention Is All You Need" published by Vaswani and colleagues in 2017.',
        'The self-attention mechanism allows the model to weigh the importance of different positions in the input sequence when computing each output element.',
        'This captures long-range dependencies that recurrent neural networks struggle with due to vanishing gradients over many time steps.',
        'The quadratic scaling of self-attention with sequence length remains an active research area.',
        'Efficient variants like linear attention, sparse attention, and sliding window attention offer subquadratic alternatives that trade some modeling capacity for dramatically better scalability to long sequences.'
      ],
      [
        'The encoder-decoder structure of the original transformer has spawned numerous specialized variants optimized for different tasks.',
        'BERT uses only the encoder stack for bidirectional representation learning, predicting masked tokens using context from both directions.',
        'GPT models use only the decoder stack for autoregressive text generation, predicting each token conditioned on all preceding tokens.',
        'These architectural choices reflect fundamentally different design goals: deep understanding of existing text versus fluent generation of new text.',
        'T5 and BART retain both encoder and decoder components, treating every NLP task as a sequence-to-sequence problem.',
        'This provides a unified framework for diverse applications including abstractive summarization, machine translation, question answering, and text classification.'
      ],
      [
        'Embedding models represent a specialized class of transformers that map text sequences into dense vector spaces.',
        'In these spaces, semantic similarity between texts corresponds to geometric proximity between their vector representations.',
        'Models like GTE, E5, and BGE-M3 are trained with contrastive learning objectives that push semantically similar texts closer together while separating dissimilar ones.',
        'The training process requires carefully curated datasets of positive and negative text pairs.',
        'Hard negative mining plays a crucial role in producing discriminative representations by selecting negative examples that are superficially similar but semantically different.',
        'The resulting vector spaces enable efficient retrieval through approximate nearest neighbor search algorithms.'
      ],
      [
        'Quantization techniques reduce model memory footprint and inference latency by representing neural network weights with fewer bits.',
        'Full-precision models use 32-bit floating point values for each weight, consuming substantial memory.',
        'Post-training quantization methods like GPTQ and AWQ can compress models to 4-bit precision with minimal quality degradation.',
        'This enables deployment on consumer hardware that lacks the memory capacity for full-precision inference.',
        'Quantization-aware training takes this further by incorporating quantization effects during the training process itself.',
        'This allows the model to adapt its weight distribution for optimal performance at the target bit width, often achieving better quality than post-training quantization alone.'
      ],
      [
        'The GGUF format, developed by the llama.cpp project, provides a flexible binary container for quantized model weights.',
        'It supports multiple quantization schemes ranging from Q2_K through Q8_0 and full F16 precision.',
        'The format stores tokenizer configuration, model hyperparameters, and tensor data in a single self-contained file.',
        'Internally, it consists of a key-value metadata section, a tensor information table describing the name, type, and offset of each tensor, and aligned binary tensor data.',
        'This design makes GGUF files both efficient to memory-map for fast loading and extensible for accommodating future model architectures and quantization methods.'
      ],
      [
        'Mixture of Experts architectures represent a paradigm shift in scaling language models efficiently.',
        'Instead of activating every parameter for every input token, MoE models route each token through a subset of specialized sub-networks called experts.',
        'This enables models with trillion-parameter total capacity while keeping the per-token computation comparable to a much smaller dense model.',
        'Switch Transformer and GShard demonstrated that sparse activation can achieve strong performance with far less compute budget.',
        'However, MoE models introduce engineering challenges around load balancing across experts, communication overhead in distributed training, and inference serving complexity when experts are distributed across multiple GPUs.'
      ]
    ]
  },
  {
    title: 'Vector Database Indexing Strategies',
    paragraphs: [
      [
        'Approximate nearest neighbor search algorithms form the foundation of modern vector databases.',
        'These algorithms trade a small amount of recall accuracy for dramatic improvements in query latency compared to exact brute-force search.',
        'HNSW (Hierarchical Navigable Small World) graphs construct a multi-layer navigation structure.',
        'Upper layers contain sparse long-range connections that provide coarse routing across the vector space.',
        'Lower layers have dense short-range connections that enable precise neighborhood exploration.',
        'The construction algorithm inserts elements one at a time, connecting each new node to its nearest neighbors at each layer with a probability that decreases exponentially with layer height.'
      ],
      [
        'IVF (Inverted File Index) takes a fundamentally different approach by partitioning the vector space into Voronoi cells using k-means clustering.',
        'At query time, only a subset of the closest cells are searched, reducing the comparison count from the full dataset size to a fraction proportional to the number of probes.',
        'Product quantization further compresses the stored vectors by decomposing each high-dimensional vector into subspaces and quantizing each subspace independently.',
        'The combination of IVF partitioning and product quantization enables billion-scale similarity search on a single machine with modest memory requirements.',
        'Facebook AI Similarity Search (FAISS) provides highly optimized implementations of these algorithms with GPU acceleration support.'
      ],
      [
        'The choice between HNSW and IVF depends heavily on deployment constraints and workload characteristics.',
        'HNSW provides excellent query latency and high recall but requires the full graph structure to reside in memory.',
        'For a billion-vector dataset with 768-dimensional embeddings, the HNSW index alone can require hundreds of gigabytes of RAM.',
        'IVF with disk-based storage can handle datasets that far exceed available RAM by loading only the relevant clusters during query processing.',
        'This makes IVF suitable for billion-scale deployments where memory cost is a primary concern.',
        'Graph-based indexes like HNSW also tend to offer better performance on high-dimensional data where the curse of dimensionality makes centroid-based partition methods less effective at separating the space.'
      ],
      [
        'Hybrid search combines dense vector retrieval with traditional keyword-based BM25 scoring to compensate for the weaknesses of each approach.',
        'Pure semantic search can struggle with exact entity names, rare technical terms, or acronyms that embedding models may not represent distinctively.',
        'Keyword search excels at exact matching but misses paraphrases and synonyms.',
        'Reciprocal rank fusion merges the ranked lists from both retrieval methods into a single ordering that benefits from both signals.',
        'Vector databases like Weaviate, Qdrant, and Milvus support hybrid search natively, allowing a single query to leverage both lexical and semantic matching without requiring separate search infrastructure.'
      ],
      [
        'Filtered vector search applies metadata predicates alongside geometric similarity computation.',
        'This returns only vectors that satisfy both the proximity constraint and the metadata conditions, such as date ranges, category tags, or access control labels.',
        'Implementing filtered search efficiently requires tight integration between the vector index and the metadata index.',
        'Pre-filtering narrows the candidate set before vector search, which is efficient when the filter is highly selective but can degrade recall when few vectors pass the filter.',
        'Post-filtering applies predicates after retrieving the top-k nearest vectors, which preserves recall but may return fewer results than requested if many candidates are filtered out.',
        'Sophisticated implementations use a combination of both strategies, choosing dynamically based on the estimated selectivity of the metadata filter.'
      ]
    ]
  },
  {
    title: 'Retrieval-Augmented Generation Pipeline',
    paragraphs: [
      [
        'Retrieval-augmented generation, commonly known as RAG, connects a large language model to an external knowledge base.',
        'This grounds the model responses in retrieved evidence rather than relying solely on parametric knowledge encoded during pretraining.',
        'The standard RAG pipeline consists of three stages: document ingestion, query-time retrieval, and augmented generation.',
        'During ingestion, documents are processed into chunks, embedded into vectors, and stored in a vector database.',
        'At query time, the user question is embedded and used to retrieve relevant chunks, which are then prepended to the language model prompt.',
        'This architecture decouples the knowledge source from the reasoning engine, allowing the knowledge base to be updated without expensive model retraining.'
      ],
      [
        'Document chunking strategy has a profound impact on retrieval quality and ultimately on the quality of generated answers.',
        'Fixed-size chunking with token overlap is the simplest approach but may split semantic units across chunk boundaries.',
        'Recursive character splitting respects structural markers like paragraphs, sentences, and section headings.',
        'Semantic chunking uses embedding similarity between consecutive sentences to identify natural topical break points.',
        'A more advanced approach called parent-child chunking indexes small chunks for precise retrieval but returns the surrounding larger context to the language model.',
        'This combines the precision of fine-grained retrieval with the coherence that comes from providing the language model with sufficient surrounding context.'
      ],
      [
        'The embedding step transforms text chunks into dense vectors for storage in a vector database.',
        'Batch processing is critical for ingestion throughput when processing large document collections.',
        'Embedding models can process hundreds of sequences simultaneously in a single forward pass.',
        'The tokens-per-second throughput generally scales with batch size up to hardware memory limits.',
        'This makes GPU acceleration particularly valuable during bulk ingestion of large document corpora.',
        'Efficient batching also requires padding sequences to uniform length within each batch.',
        'Dynamic batching algorithms group sequences of similar length together to minimize wasted computation on padding tokens.'
      ],
      [
        'Re-ranking is an optional but high-impact stage that dramatically improves retrieval precision.',
        'A cross-encoder model is applied to the top candidates from the initial bi-encoder retrieval stage.',
        'Unlike bi-encoders that independently encode the query and document, cross-encoders jointly attend to all query and document tokens simultaneously.',
        'This captures fine-grained token-level interaction signals that bi-encoder dot products cannot express.',
        'The computational cost of cross-encoding is quadratic in the combined sequence length, so re-ranking is applied only to a small candidate set, typically the top 20 to 100 results.',
        'Models like Cohere Rerank, BGE-Reranker, and cross-encoder variants from Sentence-Transformers have been specifically trained for this task.'
      ],
      [
        'Query transformation techniques improve retrieval by reformulating the original user query before executing the vector search.',
        'HyDE (Hypothetical Document Embeddings) generates a hypothetical answer to the query using the language model, then uses that answer as the search input.',
        'This bridges the semantic gap between question-style queries and declarative document passages.',
        'Multi-query retrieval generates several paraphrases or decompositions of the original question and combines their retrieval results.',
        'This increases the probability of finding relevant documents when the original phrasing does not closely match the vocabulary used in the document collection.',
        'Step-back prompting abstracts the query to a higher level before retrieval, which can help when the answer requires broader contextual knowledge than the specific question implies.'
      ]
    ]
  },
  {
    title: 'Hardware Acceleration for Neural Inference',
    paragraphs: [
      [
        'GPU acceleration for transformer inference exploits the inherent parallelism in matrix multiplications that dominate the computational workload.',
        'CUDA on NVIDIA hardware and Vulkan as a cross-platform alternative provide access to thousands of processing cores.',
        'These cores execute the same operation across different data elements simultaneously, a paradigm known as Single Instruction Multiple Data.',
        'The memory hierarchy of modern GPUs features multiple levels of cache, shared memory within compute units, and high-bandwidth HBM (High Bandwidth Memory).',
        'This hierarchy is specifically designed to feed data to the compute cores at the rates required by deep learning workloads.'
      ],
      [
        'Memory bandwidth, rather than raw compute throughput, is often the true performance bottleneck in transformer inference.',
        'The arithmetic intensity of matrix-vector products in the attention mechanism is low.',
        'This means the GPU spends more time waiting for weight data to arrive from memory than it spends performing the actual multiplications and additions.',
        'Flash attention restructures the attention computation to maximize data reuse within fast on-chip SRAM.',
        'By computing attention scores in tiles and accumulating results incrementally rather than materializing the full attention matrix, flash attention reduces HBM memory accesses from quadratic to linear in sequence length.',
        'This technique typically delivers 2-4x speedup on attention-heavy workloads while also reducing peak memory consumption.'
      ],
      [
        'Apple Silicon integrates CPU, GPU, and Neural Engine on a unified memory architecture.',
        'This eliminates the PCIe bus transfer overhead that discrete GPU systems incur when moving data between host and device memory.',
        'The Metal Performance Shaders framework provides optimized compute kernels for common neural network operations.',
        'For embedding model inference, the memory bandwidth advantage of unified memory architecture can match or even exceed discrete GPUs despite lower peak floating-point throughput.',
        'The M-series chips include dedicated AMX (Apple Matrix eXtensions) coprocessors that accelerate matrix multiplication on 16-bit and 8-bit data types with native hardware support.',
        'This makes Apple Silicon a compelling platform for on-device embedding inference in laptop and desktop applications.'
      ],
      [
        'Quantized inference on CPU has become surprisingly competitive for embedding workloads thanks to advances in SIMD vectorization.',
        'AVX-512 instructions on Intel and AMD processors and NEON instructions on ARM processors can process multiple quantized weight multiplications in a single clock cycle.',
        'The llama.cpp project has demonstrated that carefully hand-optimized CPU kernels with 4-bit quantization can achieve practical throughput for interactive applications.',
        'On modern server-class CPUs with wide SIMD execution units, embedding throughput can reach thousands of tokens per second without any GPU hardware.',
        'This is particularly relevant for deployment scenarios where GPU availability is limited or where the additional cost and power consumption of GPU infrastructure is not justified by the workload volume.'
      ],
      [
        'Edge deployment on mobile devices presents unique constraints that differ from server environments.',
        'Limited thermal budget means sustained workloads will trigger thermal throttling that reduces clock speeds.',
        'Battery life considerations require minimizing total energy consumption per inference request.',
        'Heterogeneous compute units including CPU, GPU, and dedicated NPU (Neural Processing Unit) offer different performance and efficiency profiles.',
        'Android devices with Vulkan-capable GPUs can accelerate embedding inference, but the power management subsystem may aggressively throttle sustained GPU utilization.',
        'OpenCL provides an alternative compute backend with broader device compatibility across GPU vendors.',
        'Specialized NPU hardware in recent mobile SoCs from Qualcomm, MediaTek, and Samsung offers dedicated low-power inference acceleration optimized for common neural network operations.'
      ]
    ]
  },
  {
    title: 'Benchmarking Methodology and Metrics',
    paragraphs: [
      [
        'Throughput measurement for embedding models requires disciplined methodology to produce meaningful and reproducible results.',
        'Tokens per second is the standard throughput metric, but it must be reported alongside the batch size, sequence length distribution, quantization type, and hardware configuration.',
        'Without this context, throughput numbers are essentially meaningless for comparison purposes.',
        'The relationship between batch size and throughput is typically sublinear due to memory bandwidth saturation.',
        'The optimal batch size varies considerably by model architecture, quantization level, and the specific hardware platform being used.'
      ],
      [
        'Warmup runs are essential to reach steady-state performance before measurement begins.',
        'The first inference call typically incurs substantial overhead from JIT compilation of compute kernels, initial memory pool allocation, and CPU cache population.',
        'On GPUs, the first kernel launch also triggers shader compilation and driver-level initialization.',
        'These cold-start effects can inflate the measured latency of early iterations by an order of magnitude.',
        'Production benchmarks should discard the first several iterations and report statistics computed over a sustained measurement window of many repetitions.'
      ],
      [
        'Latency percentiles reveal important performance characteristics that simple averages completely obscure.',
        'The P50 (median) latency represents the typical user experience for a randomly selected request.',
        'The P99 latency captures the tail behavior that affects the slowest one percent of requests.',
        'For real-time applications with strict responsiveness requirements, P99 latency often determines whether the system meets its service level objective.',
        'Tail latency in embedding services can be caused by diverse factors including garbage collection pauses in managed runtimes, thermal throttling under sustained load, operating system context switches, and interference from co-located workloads on shared cloud infrastructure.'
      ],
      [
        'End-to-end document processing benchmarks must account for all stages of the processing pipeline.',
        'These stages include text extraction from source formats, chunking and preprocessing, embedding computation, and vector database insertion.',
        'The embedding computation stage typically dominates total wall-clock time for in-memory workloads.',
        'However, I/O-bound stages can become the bottleneck when processing documents from networked storage systems.',
        'The vector database write path may also bottleneck if it involves synchronous replication or complex index maintenance during insertion.',
        'Profiling each stage independently helps identify the true bottleneck and directs optimization effort toward the component with the highest potential impact.'
      ],
      [
        'Reproducibility requires controlling all variables that can influence measured performance.',
        'These include model version and quantization type, hardware specifications, operating system and driver versions, ambient temperature for thermally sensitive workloads, and background process load.',
        'Publishing benchmark results without this full context makes cross-study comparisons unreliable.',
        'Community benchmark suites like MTEB (Massive Text Embedding Benchmark) provide standardized evaluation protocols.',
        'These protocols define fixed datasets, scoring metrics, and evaluation procedures that improve comparability across different research papers, blog posts, and product announcements.'
      ]
    ]
  },
  {
    title: 'Text Chunking and Tokenization',
    paragraphs: [
      [
        'Tokenization algorithms like BPE (Byte Pair Encoding) and WordPiece decompose raw text into subword units.',
        'These units balance vocabulary size against the average number of tokens needed to represent typical text.',
        'A typical embedding model with a 30,000-token vocabulary encodes English text at roughly 1.3 tokens per word.',
        'This ratio varies significantly across languages and domains.',
        'Languages with complex morphology like Finnish or Turkish, or those using non-Latin scripts like Chinese, Japanese, and Korean, may produce substantially higher token-to-word ratios.',
        'This affects both context window utilization and processing throughput, and must be considered when sizing chunk lengths.'
      ],
      [
        'Context window limits impose hard constraints on the maximum amount of text an embedding model can process in a single forward pass.',
        'Older models like GTE-Large support 512 tokens per sequence.',
        'Newer architectures like Nomic Embed and jina-embeddings-v3 extend this limit to 8,192 tokens or beyond.',
        'When a document exceeds the context window, it must be split into overlapping chunks to ensure no information is lost at boundaries.',
        'Long-context embedding models can process entire documents in a single pass, eliminating the need for chunking entirely.',
        'However, the quadratic memory cost of self-attention means that shorter-context models with intelligent chunking strategies often achieve superior throughput per dollar on the same hardware.'
      ],
      [
        'Chunk size selection requires balancing retrieval granularity against contextual completeness.',
        'Smaller chunks of 128 to 256 tokens enable highly precise retrieval of specific facts and statements.',
        'However, small chunks lose the surrounding context that may be necessary for a language model to formulate a complete answer.',
        'Larger chunks of 512 to 1024 tokens preserve more context but may dilute the relevance signal when only a single sentence within a large chunk actually matches the query.',
        'Empirical studies across multiple domains suggest that the optimal chunk size depends heavily on the nature of expected queries.',
        'Factoid questions like "What year was the company founded?" benefit from small, precise chunks, while complex analytical questions like "How does the authentication architecture ensure data privacy?" require larger passages.'
      ],
      [
        'Overlap between consecutive chunks acts as insurance against information loss at chunk boundaries.',
        'A typical overlap of 10 to 20 percent of the chunk size creates some redundancy in the stored embeddings.',
        'This redundancy is intentional: it prevents the retrieval system from missing relevant passages that happen to be split across two chunks.',
        'The additional storage and compute cost of overlapping chunks is usually modest compared to the retrieval quality improvement.',
        'This is especially true for documents with dense informational content where important statements can appear at any position.',
        'Some advanced chunking strategies dynamically adjust overlap based on the information density of the surrounding text.'
      ]
    ]
  },
  {
    title: 'Production Deployment Considerations',
    paragraphs: [
      [
        'Model serving infrastructure for embedding services must handle concurrent requests with predictable and bounded latency.',
        'Request batching at the server level groups multiple incoming embedding requests into a single model forward pass.',
        'This amortizes the fixed overhead of GPU kernel launches and memory transfers across many inputs.',
        'Dynamic batching implementations like those in NVIDIA Triton Inference Server collect requests over a configurable time window.',
        'They form the largest feasible batch before dispatching to the model, continuously balancing throughput optimization against request queuing latency.'
      ],
      [
        'Auto-scaling policies for embedding services must consider both request rate and batch utilization efficiency.',
        'A scale-to-zero strategy eliminates compute costs during idle periods but introduces cold-start latency when the first request arrives.',
        'Model loading alone can take 10 to 30 seconds depending on model size and storage backend speed.',
        'Pre-warming strategies maintain at least one active replica to serve requests without startup delay.',
        'Predictive auto-scaling analyzes historical traffic patterns and pre-provisions capacity ahead of anticipated demand spikes.',
        'This avoids the latency penalty of purely reactive scaling while keeping infrastructure costs proportional to actual demand.'
      ],
      [
        'Monitoring embedding quality in production requires proxy metrics because ground-truth relevance labels are rarely available at serving time.',
        'Useful proxy signals include retrieval hit rate, user engagement with results backed by retrieved content, and embedding distribution drift metrics.',
        'Drift detection tracks statistical properties of the embedding output distribution over time, such as vector norms, pairwise cosine similarity distributions, and cluster assignment entropy.',
        'Alerting on sudden shifts in these distributions can catch model corruption, upstream data pipeline failures, or adversarial input patterns before they impact end-user experience.',
        'Periodic offline evaluation against curated test sets provides a more rigorous quality assessment.'
      ],
      [
        'Version management for embedding models requires careful migration planning because model changes alter the vector space.',
        'Existing embeddings computed with the old model become incompatible with new embeddings.',
        'Several migration strategies exist, each with different tradeoffs between complexity, cost, and downtime.',
        'Dual-write during a transition period computes and stores embeddings from both old and new models simultaneously.',
        'Lazy re-embedding computes new embeddings on access, gradually migrating the index as documents are retrieved.',
        'Full re-indexing processes the entire document collection during a maintenance window.',
        'Shadow deployments that compute new embeddings in parallel enable quality comparison before committing to the production switch.'
      ],
      [
        'Cost optimization for embedding infrastructure requires balancing compute, storage, and network transfer costs.',
        'Dimensionality reduction through PCA projection or Matryoshka truncation reduces vector storage requirements and speeds up similarity computation.',
        'However, aggressive dimension reduction may degrade retrieval quality, so the savings must be validated against application-specific accuracy benchmarks.',
        'Embedding caching avoids redundant computation for frequently requested inputs.',
        'For large batch ingestion workloads, spot instances or preemptible virtual machines can reduce compute costs by 60 to 90 percent compared to on-demand pricing, though they require fault-tolerant job scheduling.'
      ]
    ]
  },
  {
    title: 'Security and Privacy in AI Pipelines',
    paragraphs: [
      [
        'Embedding vectors can inadvertently leak information about their source text through mathematical inversion attacks.',
        'Recent research has demonstrated that approximate reconstruction of the original text from its embedding vector is feasible.',
        'This is especially concerning for models with high-dimensional output spaces that preserve fine-grained textual details.',
        'The practical implications are significant for deployments where the vector database is accessible to parties who should not have access to the original documents.',
        'The success probability of inversion attacks depends on whether the attacker has knowledge of the embedding model architecture and its training data distribution.'
      ],
      [
        'Differential privacy offers a principled framework for protecting sensitive information in embedding vectors.',
        'By adding carefully calibrated random noise to embeddings before storage, the system provides mathematical guarantees about information leakage.',
        'The noise magnitude parameter epsilon controls the privacy-utility tradeoff.',
        'For many practical retrieval applications, a moderate noise level provides meaningful privacy protection with negligible impact on retrieval accuracy.',
        'Formal privacy analysis requires bounding the sensitivity of the embedding function to changes in individual input documents, which remains an active area of theoretical investigation.'
      ],
      [
        'Access control for RAG systems must be enforced consistently across both the retrieval and generation pipeline stages.',
        'Document-level permissions should be checked at retrieval time so that users only receive context from documents they are authorized to access.',
        'This requires metadata-aware filtering integrated into the vector database query path.',
        'Row-level security in the vector store must connect to the organization identity provider to apply consistent access policies.',
        'Without proper access controls, a RAG system could inadvertently surface confidential information from restricted documents to unauthorized users.'
      ],
      [
        'Data residency regulations like GDPR and HIPAA may constrain where embeddings can be computed and where the resulting vectors can be stored.',
        'On-device inference with locally deployed models eliminates the need to transmit sensitive text to remote cloud endpoints.',
        'This enables privacy-preserving RAG systems that process sensitive medical records, legal documents, or financial data without any data leaving the controlled environment.',
        'Federated learning approaches allow multiple organizations to collaboratively improve embedding models without sharing their raw document data.',
        'However, care must be taken because gradient updates exchanged during federated training can themselves leak information about the training data.'
      ],
      [
        'Prompt injection attacks represent an emerging threat to RAG systems.',
        'Adversarial content embedded within documents in the knowledge base can manipulate the language model behavior when those documents are retrieved and included in the prompt.',
        'Defensive strategies include input sanitization that strips or escapes potentially dangerous patterns, output validation that checks generated responses against policy constraints, and instruction hierarchy mechanisms that give system-level prompts priority over content from retrieved documents.',
        'Active monitoring for anomalous retrieval patterns can also detect attempts to poison the knowledge base with adversarial content designed to trigger specific model behaviors or extract system prompt information.'
      ]
    ]
  },
  {
    title: 'Future Directions and Emerging Techniques',
    paragraphs: [
      [
        'Matryoshka representation learning trains embedding models that produce vectors which can be truncated to lower dimensions without any retraining or fine-tuning.',
        'The first d dimensions of a Matryoshka embedding form a complete and valid embedding in a d-dimensional space.',
        'This enables dynamic precision-recall tradeoffs at query time simply by choosing how many dimensions to include in the similarity computation.',
        'The training objective simultaneously optimizes embedding quality at multiple dimensionality checkpoints.',
        'This produces representations that degrade gracefully as trailing dimensions are removed, rather than collapsing abruptly as with truncation of standard embeddings.'
      ],
      [
        'Late interaction models like ColBERT represent a middle ground between efficient bi-encoders and powerful cross-encoders.',
        'Rather than compressing each text into a single vector, ColBERT retains one embedding per token in both the query and the document.',
        'Relevance is computed as the sum of maximum similarity scores between each query token embedding and the most similar document token embedding.',
        'This captures fine-grained lexical matching signals while remaining far more efficient than full cross-attention between query and document.',
        'ColBERTv2 compresses the per-token document embeddings through residual quantization, reducing storage overhead to levels competitive with single-vector representations.'
      ],
      [
        'Instruction-tuned embedding models accept a natural language task description alongside the input text.',
        'The task instruction steers the model to produce embeddings optimized for the specified downstream use case.',
        'This eliminates the need to train and maintain separate models for retrieval, classification, clustering, and semantic similarity tasks.',
        'Models like E5-Mistral and GritLM have demonstrated that a single instruction-following embedding model can match or exceed the performance of dedicated task-specific models across diverse evaluation benchmarks.',
        'This unification significantly simplifies the model management burden for production systems that serve multiple embedding use cases.'
      ],
      [
        'Speculative embedding is an emerging technique that applies the principles of speculative decoding to the embedding pipeline.',
        'A small, fast model generates draft embeddings for all chunks in a batch.',
        'Only chunks whose draft embeddings fall near decision boundaries or have low confidence scores are then processed by a larger, more accurate model.',
        'For typical retrieval workloads, the majority of chunks are either clearly relevant or clearly irrelevant.',
        'These clear cases do not benefit from higher-precision embeddings, so the small model suffices.',
        'This approach can substantially reduce average inference cost while maintaining end-to-end retrieval quality.'
      ],
      [
        'Multi-modal embedding models extend text-only vector spaces to encompass images, audio, and video content.',
        'CLIP and its successors learn to project different modalities into a shared geometric space where cross-modal similarity is meaningful.',
        'A text query like "sunset over the ocean" retrieves both relevant text passages and matching photographs.',
        'Unified multi-modal embeddings enable entirely new application categories including visual question answering over document images, audio content search using natural language queries, and cross-lingual document retrieval using images as a language-agnostic bridge.'
      ],
      [
        'Sparse-dense hybrid representations combine the interpretability of sparse vectors with the semantic generalization of dense embeddings.',
        'SPLADE and similar learned sparse models produce token-level importance weights that can be stored and searched using traditional inverted indexes.',
        'This achieves competitive or superior retrieval quality compared to dense-only approaches while enabling efficient implementation on existing search infrastructure.',
        'The hybrid approach is particularly attractive for organizations that have significant investment in established search platforms and want to add semantic capabilities without deploying separate vector database infrastructure.'
      ]
    ]
  },
  {
    title: 'Conclusion and Practical Recommendations',
    paragraphs: [
      [
        'Building an effective embedding pipeline requires careful attention to every component in the processing chain.',
        'Model selection should balance embedding quality metrics against inference throughput and deployment cost constraints.',
        'For most production use cases, a well-quantized medium-sized model like GTE-Large at F16 or Q8 precision provides an excellent quality-to-performance ratio.',
        'Larger models should be reserved for applications where marginal retrieval quality improvements directly translate to meaningful business value that justifies the additional infrastructure investment.'
      ],
      [
        'Chunking strategy should be tuned empirically using representative queries drawn from the actual target application.',
        'Starting with 256-token chunks and 10 to 20 percent overlap provides a robust default configuration for general-purpose retrieval.',
        'Applications that process highly structured documents like technical manuals, legal contracts, or medical records may benefit from document-aware chunking that respects section boundaries, table structures, and code blocks.',
        'Evaluation should always measure end-to-end retrieval quality on a held-out test set rather than optimizing embedding similarity in isolation.',
        'The complex interactions between chunking, embedding, indexing, and re-ranking stages can produce non-obvious emergent behaviors that only manifest in integrated evaluation.'
      ],
      [
        'Infrastructure decisions should prioritize operational observability and graceful degradation under failure conditions.',
        'Embedding services should expose comprehensive metrics including per-request latency histograms, batch utilization rates, model load times, queue depths, and error rates broken down by category.',
        'Circuit breakers and fallback mechanisms ensure that temporary embedding service failures degrade application quality gracefully rather than causing cascading outages across dependent services.',
        'Regular load testing against production-representative workloads, including realistic query distributions and concurrent user counts, validates that the system meets its performance targets under conditions that match actual deployment.'
      ],
      [
        'The field of text embeddings continues to advance rapidly with innovations in model architectures, training methodologies, and deployment optimization techniques.',
        'Adopting a modular pipeline architecture that separates document processing, embedding computation, vector indexing, and retrieval into independently upgradeable components is essential for long-term maintainability.',
        'This separation ensures that breakthroughs in any single area, whether a new embedding model, a more efficient vector index, or an improved chunking algorithm, can be adopted without disrupting the overall system.',
        'This architectural flexibility is arguably the most important long-term investment for engineering teams building production-grade retrieval systems that must evolve alongside the rapidly advancing state of the art.'
      ]
    ]
  }
]

function generateDocument () {
  const lines = []
  const title = '10-Page Technical Document: AI Infrastructure and Embedding Systems'
  lines.push(title)
  lines.push('='.repeat(title.length))
  lines.push('')

  for (const section of SECTIONS) {
    lines.push(section.title)
    lines.push('-'.repeat(section.title.length))
    lines.push('')
    for (const paragraph of section.paragraphs) {
      lines.push(paragraph.join(' '))
      lines.push('')
    }
  }

  return lines.join('\n')
}

function chunkDocument (text, chunkSize, overlap) {
  const words = text.split(/\s+/).filter(Boolean)
  const chunks = []
  let start = 0

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length)
    chunks.push(words.slice(start, end).join(' '))
    if (end >= words.length) break
    start += chunkSize - overlap
  }

  return chunks
}

function getDocumentStats (text) {
  const words = text.split(/\s+/).filter(Boolean)
  const chars = text.length
  const sentences = text.split(/[.!?]+/).filter(Boolean).length
  const paragraphs = text.split(/\n\n+/).filter(Boolean).length
  const pages = Math.ceil(words.length / WORDS_PER_PAGE)
  return { words: words.length, chars, sentences, paragraphs, pages }
}

if (require.main === module) {
  const outputDir = path.resolve(__dirname, '../document-throughput')
  fs.mkdirSync(outputDir, { recursive: true })

  const document = generateDocument()
  const outputPath = path.join(outputDir, 'sample-document.txt')
  fs.writeFileSync(outputPath, document)

  const stats = getDocumentStats(document)
  console.log('Generated 10-page document:')
  console.log(`  Words:      ${stats.words}`)
  console.log(`  Characters: ${stats.chars}`)
  console.log(`  Sentences:  ${stats.sentences}`)
  console.log(`  Paragraphs: ${stats.paragraphs}`)
  console.log(`  Est. pages: ${stats.pages}`)
  console.log(`  Path:       ${outputPath}`)
}

module.exports = {
  generateDocument,
  chunkDocument,
  getDocumentStats,
  WORDS_PER_PAGE,
  TARGET_PAGES
}
