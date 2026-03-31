# Marian Addon Benchmark Client

A Python client for benchmarking Marian translation addons. It sends requests to the Marian addon server and compares the results with the desired metric.

## Features

- HTTP client for Marian translation service
- [FLORES+](https://huggingface.co/datasets/openlanguagedata/flores_plus) dataset integration
- Multiple evaluation metrics (BLEU, COMET, XCOMET)
- Configurable batch processing

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac-lib-inference-addon-mlc-marian.git
cd qvac-lib-inference-addon-mlc-marian/benchmarks/client

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
  batch_size: 32
  lib: "@qvac/translation-nmtcpp"

huggingface:
  token: "your_huggingface_token"

dataset:
  src_lang: "eng_Latn"
  dst_lang: "deu_Latn"

bleu:
  enabled: true
  smooth_method: "exp"
  lowercase: false
  tokenizer: "flores200"
  force_tokenize: false
  use_effective_order: false

comet:
  enabled: true
  xcomet: true
  batch_size: 16
  gpus: 1
```

### Configuration Details

- **Server**:
  - `url`: The URL of the Marian addon server
  - `batch_size`: The number of sentences to translate in each request
  - `lib`: The Marian addon library to use
- **HuggingFace**:
  - `token`: Your HuggingFace token for accessing the FLORES+ dataset and COMET models
- **Dataset**:
  - `src_lang`: Source language code in `ISO 639-3_ISO 15924` format from FLORES+ dataset
  - `dst_lang`: Target language code in `ISO 639-3_ISO 15924` format from FLORES+ dataset
- **BLEU**:
  - `enabled`: Enable BLEU score calculation
  - `smooth_method`: Choose between `floor`, `add-k`, `exp` smoothing methods. Default is `exp`.
  - `lowercase`: Convert text to lowercase. Default is `false`.
  - `tokenizer`: Choose between `flores200`, `flores101`, `flores13a`, `intl`, `char`, `ja-mecab`, `ko-mecab`, `spm`. Default is `flores200`.
  - `force_tokenize`: Force tokenization even if data appears to be tokenized. Default is `false`.
  - `use_effective_order`: Don't take into account n-gram orders without any match. Default is `false`.
- **COMET**:
  - `enabled`: Enable COMET score calculation
  - `xcomet`: Enable XCOMET score calculation
  - `batch_size`: The batch size to use for COMET score calculation
  - `gpus`: The number of GPUs to use for COMET score calculation

## Usage

Run the benchmark with:

```bash
poetry run python -m src.marian.main --config config/config.yaml
```

The client will:

1. Load the FLORES+ dataset
2. Send translation requests to the server
3. Calculate BLEU score
4. Calculate COMET and XCOMET scores
5. Report timing statistics

## Output

- BLEU score (if enabled)
- COMET score (if enabled)
- XCOMET score (if enabled)
- Total model load time
- Total translation time

## Development

### Running Tests

```bash
poetry run python -m pytest tests/ -v
```

## Acknowledgments

<details>
<summary>Cite as:</summary>

```bibtex
@inproceedings{post-2018-call,
  title     = "A Call for Clarity in Reporting {BLEU} Scores",
  author    = "Post, Matt",
  booktitle = "Proceedings of the Third Conference on Machine Translation: Research Papers",
  month     = oct,
  year      = "2018",
  address   = "Belgium, Brussels",
  publisher = "Association for Computational Linguistics",
  url       = "https://www.aclweb.org/anthology/W18-6319",
  pages     = "186--191",
}

@article{nllb-24,
  author="{NLLB Team} and Costa-juss{\`a}, Marta R. and Cross, James and {\c{C}}elebi, Onur and Elbayad, Maha and Heafield, Kenneth and Heffernan, Kevin and Kalbassi, Elahe and Lam, Janice and Licht, Daniel and Maillard, Jean and Sun, Anna and Wang, Skyler and Wenzek, Guillaume and Youngblood, Al and Akula, Bapi and Barrault, Loic and Gonzalez, Gabriel Mejia and Hansanti, Prangthip and Hoffman, John and Jarrett, Semarley and Sadagopan, Kaushik Ram and Rowe, Dirk and Spruit, Shannon and Tran, Chau and Andrews, Pierre and Ayan, Necip Fazil and Bhosale, Shruti and Edunov, Sergey and Fan, Angela and Gao, Cynthia and Goswami, Vedanuj and Guzm{\'a}n, Francisco and Koehn, Philipp and Mourachko, Alexandre and Ropers, Christophe and Saleem, Safiyyah and Schwenk, Holger and Wang, Jeff",
  title="Scaling neural machine translation to 200 languages",
  journal="Nature",
  year="2024",
  volume="630",
  number="8018",
  pages="841--846",
  issn="1476-4687",
  doi="10.1038/s41586-024-07335-x",
  url="https://doi.org/10.1038/s41586-024-07335-x"
}

@misc{gala2023indictrans2highqualityaccessiblemachine,
      title={IndicTrans2: Towards High-Quality and Accessible Machine Translation Models for all 22 Scheduled Indian Languages}, 
      author={Jay Gala and Pranjal A. Chitale and Raghavan AK and Varun Gumma and Sumanth Doddapaneni and Aswanth Kumar and Janki Nawale and Anupama Sujatha and Ratish Puduppully and Vivek Raghavan and Pratyush Kumar and Mitesh M. Khapra and Raj Dabre and Anoop Kunchukuttan},
      year={2023},
      eprint={2305.16307},
      archivePrefix={arXiv},
      primaryClass={cs.CL},
      url={https://arxiv.org/abs/2305.16307}, 
}
```

</details>

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
