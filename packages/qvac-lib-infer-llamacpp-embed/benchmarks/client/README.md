# Embeddings Addon Benchmark Client

A Python client for benchmarking Embeddings addons using the [MTEB (Massive Text Embedding Benchmark)](https://github.com/embeddings-benchmark/mteb) framework. It sends requests to the Embeddings addon server and evaluates performance across multiple datasets and metrics.

## Features

- HTTP client for embeddings service
- MTEB dataset integration
- Multiple evaluation metrics (nDCG@k, MRR@k, Recall@k, Precision@k)
- Configurable batch processing
- Results generation and summary
- Support for various embedding models (GTE-Large, etc.)

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac-lib-inference-embeddings-mlc.git
cd qvac-lib-inference-embeddings-mlc/benchmarks/client

# Install poetry if you haven't already
curl -sSL https://install.python-poetry.org | python3 -

# Install dependencies
poetry install
```

## Configuration

Create a `config.yaml` file with the following structure:

```yaml
server:
  url: "http://localhost:8080/run"
  batch_size: 20                  # Changed from 32 to 20 for smaller batch sizes
  timeout: 300                    # Added custom timeout for long-running embedding calls
  lib: "@tetherto/embed-llamacpp" # Updated addon library
  version: "2.1.0"                # Updated addon version
  config:
    modelFilePath: "../../models/gte-large_fp16.gguf" # Path to the local GGUF model file
    addonConfig: "-ngl\t75"                            # Runtime config passed to addon (e.g., GPU layer limit)
dataset: ["ArguAna", "NFCorpus", "SciFact", "TRECCOVID", "SCIDOCS"] # Updated dataset list

```

### Configuration Details

- **Server**:
  - `url`: The URL of the embeddings addon server
  - `batch_size`: The number of sentences to embed in each request
  - `lib`: The embeddings addon library to use
  - `version`: The version of the addon library
- **Dataset**: List of dataset names to evaluate. Available datasets include:
  - `ArguAna`: Argument Analysis Dataset
  - `FiQA2018`: Financial Opinion Mining and Question Answering
  - `NFCorpus`: Natural Feedback Corpus
  - `SCIDOCS`: Scientific Document Similarity Dataset
  - `SciFact`: Scientific Factuality Verification
  - `TRECCOVID`: COVID-19 Pandemic Information Retrieval Test Collection
  - Any other dataset from MTEB

## Usage

Run the benchmark with:

```bash
poetry run python -m src.gte.main --config config/config.yaml
```

The client will:

1. Load the specified datasets from MTEB
2. Send embedding requests to the server in batches
3. Calculate evaluation metrics (nDCG@k, MRR@k, Recall@k, Precision@k)
4. Generate individual benchmark result files
5. Create an aggregated benchmark summary

### Command Line Options

- `--config`: Path to the configuration file (default: `config/config.yaml`)
- `--max-retries`: Maximum number of retry attempts for failed requests (default: 5)
- `--base-delay`: Base delay for exponential backoff in seconds (default: 2.0)

## Output

The benchmark generates:

1. **Individual Results**: Markdown files for each dataset under `benchmarks/results/<quantization>/`

   - Example: `NQ-gte-large-q4f16_1.md`
   - Contains detailed metrics and performance data

2. **Summary Report**: `benchmarks/results/results_summary.md`
   - Aggregated table with all results
   - Reference documentation for metrics

## Development

### Running Tests

```bash
poetry run python -m pytest tests/ -v
```

## Acknowledgments

<details>
<summary>Cite as:</summary>

```bibtex
@article{muennighoff2022mteb,
  author = {Muennighoff, Niklas and Tazi, Nouamane and Magne, Lo{\"\i}c and Reimers, Nils},
  title = {MTEB: Massive Text Embedding Benchmark},
  publisher = {arXiv},
  journal={arXiv preprint arXiv:2210.07316},
  year = {2022}
  url = {https://arxiv.org/abs/2210.07316},
  doi = {10.48550/ARXIV.2210.07316},
}

@article{enevoldsen2025mmtebmassivemultilingualtext,
  title={MMTEB: Massive Multilingual Text Embedding Benchmark},
  author={Kenneth Enevoldsen and Isaac Chung and Imene Kerboua and Márton Kardos and Ashwin Mathur and David Stap and Jay Gala and Wissam Siblini and Dominik Krzemiński and Genta Indra Winata and Saba Sturua and Saiteja Utpala and Mathieu Ciancone and Marion Schaeffer and Gabriel Sequeira and Diganta Misra and Shreeya Dhakal and Jonathan Rystrøm and Roman Solomatin and Ömer Çağatan and Akash Kundu and Martin Bernstorff and Shitao Xiao and Akshita Sukhlecha and Bhavish Pahwa and Rafał Poświata and Kranthi Kiran GV and Shawon Ashraf and Daniel Auras and Björn Plüster and Jan Philipp Harries and Loïc Magne and Isabelle Mohr and Mariya Hendriksen and Dawei Zhu and Hippolyte Gisserot-Boukhlef and Tom Aarsen and Jan Kostkan and Konrad Wojtasik and Taemin Lee and Marek Šuppa and Crystina Zhang and Roberta Rocca and Mohammed Hamdy and Andrianos Michail and John Yang and Manuel Faysse and Aleksei Vatolin and Nandan Thakur and Manan Dey and Dipam Vasani and Pranjal Chitale and Simone Tedeschi and Nguyen Tai and Artem Snegirev and Michael Günther and Mengzhou Xia and Weijia Shi and Xing Han Lù and Jordan Clive and Gayatri Krishnakumar and Anna Maksimova and Silvan Wehrli and Maria Tikhonova and Henil Panchal and Aleksandr Abramov and Malte Ostendorff and Zheng Liu and Simon Clematide and Lester James Miranda and Alena Fenogenova and Guangyu Song and Ruqiya Bin Safi and Wen-Ding Li and Alessia Borghini and Federico Cassano and Hongjin Su and Jimmy Lin and Howard Yen and Lasse Hansen and Sara Hooker and Chenghao Xiao and Vaibhav Adlakha and Orion Weller and Siva Reddy and Niklas Muennighoff},
  publisher = {arXiv},
  journal={arXiv preprint arXiv:2502.13595},
  year={2025},
  url={https://arxiv.org/abs/2502.13595},
  doi = {10.48550/arXiv.2502.13595},
}

@article{47761,
  author = {Tom Kwiatkowski and Jennimaria Palomaki and Olivia Redfield and Michael Collins and Ankur Parikh
and Chris Alberti and Danielle Epstein and Illia Polosukhin and Matthew Kelcey and Jacob Devlin and Kenton Lee
and Kristina N. Toutanova and Llion Jones and Ming-Wei Chang and Andrew Dai and Jakob Uszkoreit and Quoc Le
and Slav Petrov},
  journal = {Transactions of the Association of Computational
Linguistics},
  title = {Natural Questions: a Benchmark for Question Answering Research},
  year = {2019},
}

@inproceedings{thakur2021beir,
  author = {Nandan Thakur and Nils Reimers and Andreas R{\"u}ckl{\'e} and Abhishek Srivastava and Iryna Gurevych},
  booktitle = {Thirty-fifth Conference on Neural Information Processing Systems Datasets and Benchmarks Track (Round 2)},
  title = {{BEIR}: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models},
  url = {https://openreview.net/forum?id=wCu6T5xFjeJ},
  year = {2021},
}

@inproceedings{thorne-etal-2018-fever,
  abstract = {In this paper we introduce a new publicly available dataset for verification against textual sources, FEVER: Fact Extraction and VERification. It consists of 185,445 claims generated by altering sentences extracted from Wikipedia and subsequently verified without knowledge of the sentence they were derived from. The claims are classified as Supported, Refuted or NotEnoughInfo by annotators achieving 0.6841 in Fleiss kappa. For the first two classes, the annotators also recorded the sentence(s) forming the necessary evidence for their judgment. To characterize the challenge of the dataset presented, we develop a pipeline approach and compare it to suitably designed oracles. The best accuracy we achieve on labeling a claim accompanied by the correct evidence is 31.87{\%}, while if we ignore the evidence we achieve 50.91{\%}. Thus we believe that FEVER is a challenging testbed that will help stimulate progress on claim verification against textual sources.},
  address = {New Orleans, Louisiana},
  author = {Thorne, James  and
Vlachos, Andreas  and
Christodoulopoulos, Christos  and
Mittal, Arpit},
  booktitle = {Proceedings of the 2018 Conference of the North {A}merican Chapter of the Association for Computational Linguistics: Human Language Technologies, Volume 1 (Long Papers)},
  doi = {10.18653/v1/N18-1074},
  editor = {Walker, Marilyn  and
Ji, Heng  and
Stent, Amanda},
  month = jun,
  pages = {809--819},
  publisher = {Association for Computational Linguistics},
  title = {{FEVER}: a Large-scale Dataset for Fact Extraction and {VER}ification},
  url = {https://aclanthology.org/N18-1074},
  year = {2018},
}
```

</details>

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
