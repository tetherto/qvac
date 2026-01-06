# Aggregated Benchmark Results

This summary consolidates benchmarking results across all datasets.

Original Model: [GTE-Large](https://huggingface.co/thenlper/gte-large)

| Dataset   | Languages | Model     | Quantization | Version | nDCG@k (k=10) | MRR@k (k=10) | Recall@k (k=10) | Precision@k (k=10) | Notes            |
| --------- | --------- | --------- | ------------ | ------- | ------------- | ------------ | --------------- | ------------------ | ---------------- |
| ArguAna  | eng-Latn  | gte-large     | llamacpp      | 2.1.0   | 0.57515       | 0.487032     | 0.86344          | 0.08634            | Performed on GPU            |
| NFCorpus  | eng-Latn  | gte-large     | llamacpp      | 2.1.0   | 0.38071       | 0.571158     | 0.19144          | 0.28390            | Performed on GPU            |
| SCIDOCS  | eng-Latn  | gte-large     | llamacpp      | 2.1.0   | 0.22413       | 0.372563     | 0.23600          | 0.11650            | Performed on GPU            |
| SciFact  | eng-Latn  | gte-large     | llamacpp      | 2.1.0   | 0.73769       | 0.700255     | 0.86822          | 0.09867            | Performed on GPU            |
| TRECCOVID  | eng-Latn  | gte-large     | llamacpp      | 2.1.0   | 0.70640       | 0.885000     | 0.02032          | 0.75400            | Performed on GPU            |
| ArguAna  | eng-Latn  | gte-large     | mlc      | 2.0.0   | 0.57143       | 0.484826     | 0.85491          | 0.08549            | Performed on GPU            |
| NFCorpus  | eng-Latn  | gte-large     | mlc      | 2.0.0   | 0.01359       | 0.020991     | 0.00746          | 0.01517            | Performed on GPU            |
| SciFact  | eng-Latn  | gte-large     | mlc      | 2.0.0   | 0.02708       | 0.023306     | 0.04167          | 0.00433            | Performed on GPU            |
| ArguAna  | eng-Latn  | gte-large     | q4f16_1      | 1.0.0   | 0.55500       | 0.468582     | 0.83499          | 0.08350            | Performed on GPU            |
| FiQA2018  | eng-Latn  | gte-large     | q4f16_1      | 1.0.0   | 0.39460       | 0.471460     | 0.46684          | 0.11157            | Performed on GPU            |
| NFCorpus  | eng-Latn  | gte-large     | q4f16_1      | 1.0.0   | 0.36932       | 0.561499     | 0.18280          | 0.27121            | Performed on GPU            |
| SCIDOCS  | eng-Latn  | gte-large     | q4f16_1      | 1.0.0   | 0.22968       | 0.378919     | 0.24382          | 0.12050            | Performed on GPU            |
| SciFact  | eng-Latn  | gte-large     | q4f16_1      | 1.0.0   | 0.71767       | 0.678783     | 0.86394          | 0.09733            | Performed on GPU            |
| TRECCOVID  | eng-Latn  | gte-large     | q4f16_1      | 1.0.0   | 0.72319       | 0.903333     | 0.02063          | 0.77200            | Performed on GPU            |

## Reference

### nDCG@k (Normalized Discounted Cumulative Gain)

Evaluates how well the ranked list of retrieved passages reflects ideal (ground-truth) relevance, discounted by position.

Range: 0 – 1, **Higher = better**

| **Score Range** | **Interpretation**                                 |
| --------------- | -------------------------------------------------- |
| 0.9 – 1.0       | Excellent; rankings are almost perfectly ideal     |
| 0.7 – 0.9       | Strong; minor ranking imperfections                |
| 0.5 – 0.7       | Adequate; some relevant items are pushed down      |
| < 0.5           | Weak; many relevant items appear low in the list   |

---

### MRR@k (Mean Reciprocal Rank)

Measures the position of the **first relevant** item in each query's ranked list; averages the reciprocal of that rank across all queries.

Range: 0 – 1, **Higher = better**

| **Score Range** | **Interpretation**                               |
| --------------- | ------------------------------------------------ |
| 0.9 – 1.0       | Excellent; relevant result is almost always top  |
| 0.7 – 0.9       | Strong; relevant result usually in top few ranks |
| 0.4 – 0.7       | Moderate; users may need to scroll                |
| < 0.4           | Poor; relevant result often buried                |

---

### Recall@k

Proportion of all relevant items that appear within the top _k_ results.

Range: 0 – 1, **Higher = better**

| **Score Range** | **Interpretation**                                |
| --------------- | ------------------------------------------------- |
| 0.9 – 1.0       | Excellent coverage; nearly all relevant items found |
| 0.7 – 0.9       | Strong coverage                                    |
| 0.5 – 0.7       | Adequate; may miss some relevant items             |
| < 0.5           | Limited; many relevant items missed                |

---

### Precision@k

Fraction of the top _k_ retrieved items that are relevant.

Range: 0 – 1, **Higher = better**

| **Score Range** | **Interpretation**                              |
| --------------- | ----------------------------------------------- |
| 0.9 – 1.0       | Excellent precision; very few false positives   |
| 0.7 – 0.9       | Strong precision                                |
| 0.5 – 0.7       | Acceptable; noticeable non-relevant items       |
| < 0.5           | Low precision; many non-relevant items returned |

---
