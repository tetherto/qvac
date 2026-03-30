from typing import List, Tuple
from comet import download_model, load_from_checkpoint
from src.indictrans2.config import CometConfig


def calculate_comet(
    sources: List[str],
    machine_translations: List[str],
    references: List[str],
    config: CometConfig,
) -> Tuple[float, float | None]:
    """
    Calculate COMET and XCOMET scores for a set of hypotheses against references.

    Args:
        sources: List of source sentences
        machine_translations: List of machine translations
        references: List of reference translations
        config: COMET configuration parameters

    Returns:
        Tuple[float, float]: COMET and XCOMET scores
    """
    data = [
        {
            "src": src,
            "mt": mt,
            "ref": ref,
        }
        for src, mt, ref in zip(sources, machine_translations, references)
    ]

    xcomet_model_output = None
    comet_model_path = download_model("Unbabel/wmt22-comet-da")
    comet_model = load_from_checkpoint(comet_model_path)
    comet_model_output = comet_model.predict(
        data, batch_size=config.batch_size, gpus=config.gpus
    )

    if config.xcomet:
        xcomet_model_path = download_model("Unbabel/XCOMET-XL")
        xcomet_model = load_from_checkpoint(xcomet_model_path)
        xcomet_model_output = xcomet_model.predict(
            data, batch_size=config.batch_size, gpus=config.gpus
        )

    return comet_model_output.system_score, (
        xcomet_model_output.system_score if config.xcomet else None
    )
