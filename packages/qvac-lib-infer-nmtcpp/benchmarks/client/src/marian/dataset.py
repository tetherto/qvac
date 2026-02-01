from typing import List, Tuple
from datasets import load_dataset
from src.marian.config import DatasetConfig, Config


def load_flores_dataset(cfg: DatasetConfig) -> Tuple[List[str], List[str]]:
    """
    Download and load the FLORES+ dev split for a given language pair.

    Args:
        cfg: DatasetConfig containing:
            - src_lang: ISO 639-3_ISO 15924 source language code (e.g. eng_Latn)
            - dst_lang: ISO 639-3_ISO 15924 target language code (e.g. deu_Latn)
    Returns:
        sources: List[str] of source sentences
        references: List[str] of reference sentences
    Raises:
        ValueError: if the language codes are not in the dataset
    """
    ds_source = load_dataset(
        path="openlanguagedata/flores_plus",
        name=cfg.src_lang,
        split="dev",
    ).to_pandas()
    ds_target = load_dataset(
        path="openlanguagedata/flores_plus",
        name=cfg.dst_lang,
        split="dev",
    ).to_pandas()

    sources = ds_source["text"].tolist()
    references = ds_target["text"].tolist()

    return sources, references


if __name__ == "__main__":
    cfg = Config.from_yaml()
    srcs, refs = load_flores_dataset(cfg.dataset)
    print(
        f"Loaded {len(srcs)} source sentences and {len(refs)} references from FLORES+."
    )
    print("Example source:", srcs[:2])
    print("Example reference:", refs[:2])
