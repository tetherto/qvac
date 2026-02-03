# Addon Benchmark Results Summary

## Performance and Configuration Metrics

| Addon | Version | Model Size | SQuAD EM | SQuAD F1 | ARC Acc | MMLU Acc | GSM8K (0 shot) Acc | Temperature | Top-p | Context Window | Prefill Chunk | Max Tokens |
|-------|---------|------------|-----------|-----------|----------|-----------|------------|-------------|-------|----------------|---------------|------------|
| llama-3_2_1b-q4f16_1 | 1.0.0 | 1B | 44.63% | 47.5% | 50.9% | 36.15% | 26.76% | 0.7 | 0.9 | 8000 | 1024 | 500 |
| llama-3_2_3b-q4f16_1 | 1.0.0 | 3B | 38% | 44% | 69.7% | 58% (6k samples) | 62.5% | 0.7 | 0.9 | 8000 | 1024 | 500 |
| Meta-llama-3_2_1b-Instruct | - | 1B | 31.39% | 37.43% | 46.8% | 40.6% | 32.1% | 0.6 | 0.9 | 8000 | 1024 | 500 |
| Meta-llama-3_2_3b-Instruct | - | 3B | 46.6% | 51.1% | 70.9% | 45.6% | 52.2% | 0.6 | 0.9 | 8000 | 1024 | 500 |
| medgemma-4b-it-Q4_1 | - | 4B | 48.90% | 53.58% | 76.0% | 54.0% | 68.1% | 0.7 | 0.9 | 8000 | 1024 | 500 |
| Qwen3-4B-Q4_K_M | - | 4B | 30.0% | 31.9% | 70.0% | 48.3% | 50.9% | 0.7 | 0.9 | 8000 | 1024 | 500 |

## Dataset and Metric Explanations

### **SQuAD (Stanford Question Answering Dataset)**
- **Purpose**: Evaluates reading comprehension and question-answering capabilities
- **Format**: **Free-form answer generation** - models must generate the exact answer text
- **SQuAD EM (Exact Match)**: Measures the percentage of predictions that exactly match the ground truth answer
- **SQuAD F1**: Measures the harmonic mean of precision and recall for answer span prediction, allowing for partial credit

### **ARC (AI2 Reasoning Challenge)**
- **Purpose**: Tests scientific reasoning and knowledge across multiple-choice questions
- **Format**: **Multiple choice** - models select from 4 answer options (A, B, C, D)
- **ARC Accuracy**: Percentage of correctly answered science questions that require reasoning beyond simple fact retrieval

### **MMLU (Massive Multitask Language Understanding)**
- **Purpose**: Comprehensive evaluation across 57 academic subjects including STEM, humanities, and professional domains
- **Format**: **Multiple choice** - models select from 4 answer options (A, B, C, D) for each question
- **MMLU Accuracy**: Average accuracy across all subjects, measuring broad knowledge and understanding capabilities

### **GSM8K (Grade School Math 8K)**
- **Purpose**: Tests mathematical reasoning and problem-solving abilities through grade school-level word problems
- **Format**: **Free-form answer generation** - models must generate the numerical answer with step-by-step reasoning
- **GSM8K (0-shot) Accuracy**: Performance on mathematical problems without any examples or demonstrations

### **Configuration Parameters**
- **Temperature**: Controls randomness in text generation (0.0 = deterministic, 1.0 = very random)
- **Top-p**: Nucleus sampling parameter that limits token selection to the most likely tokens
- **Context Window**: Maximum number of tokens the model can process in a single input
- **Prefill Chunk**: Size of text chunks processed during the initial context loading phase
- **Max Tokens**: Maximum number of tokens the model can generate in response


