#!/usr/bin/env python3
"""Download EmbeddingGemma-300M and convert it to GGUF with its Dense layers.

EmbeddingGemma ends with two Dense projections (768 -> 3072 -> 768) after mean
pooling. The Fabric converter writes them as dense_2 and dense_3 only with
--sentence-transformers-dense-modules; without them the model still loads but
returns pooled hidden states instead of EmbeddingGemma embeddings.

Requires a qvac-fabric-llm.cpp checkout and its converter requirements
(requirements/requirements-convert_hf_to_gguf.txt); Q4_0 also needs the
checkout's llama-quantize. Every source file is checked against a pinned
SHA256 before conversion. No output is uploaded.
"""
import argparse
import hashlib
from pathlib import Path
import subprocess
import sys

REVISIONS = {
    "google/embeddinggemma-300m": "57c266a740f537b4dc058e1b0cda161fd15afa75",
    # Ungated mirror with byte-identical files, for use without Gemma access.
    "unsloth/embeddinggemma-300m": "bfa3c846ac738e62aa61806ef9112d34acb1dc5a",
}
FILES = {
    "1_Pooling/config.json": "35bbd47d7fdf1e378db6130bcc668b09d1aa67a7bbf7c8f89a9c71f4cc8ebcc6",
    "2_Dense/config.json": "0661e5e0b67b8f8408ab31ab5d073a78972fc1dc24a49992a64796557e4f9e53",
    "2_Dense/model.safetensors": "c327f2acb00149676ade24a75e11eb6ebbd367f9ee050267ba56829d2979f702",
    "3_Dense/config.json": "8c4575c49353d63fb907878856ba94384635c3b2711fd5b7439e7f71888c66fc",
    "3_Dense/model.safetensors": "ffb6cc5162e11e2ce6bc2367e121ee3bbbc4e82e1ee26826bd7573d4948d81b8",
    "README.md": "e53702f564878ea87085742fe3f485872bef81317086e9ffe37125a81809772a",
    "added_tokens.json": "50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946",
    "config.json": "8f863f76e2d9c710cc833dc92efa898c9adfd41031c786507cc6b0e49c2e3e68",
    "config_sentence_transformers.json": "8eadac15526f83d8950aa8d962a7f4f6e3d678bea71689960194561f33a5f64f",
    "generation_config.json": "1fb1efd221c1ca88a736d1b36cb47d754c177677e222acb3b1e5424c5d664870",
    "model.safetensors": "cbf5a78393b6a033e0b8a63a57549964f7ed5c6fbeb4ba0694214f36123f2fd2",
    "modules.json": "5b5649645fb756dad1a8e2efe7872d3bb32bc00b93c95f276dd17f474eedccdc",
    "sentence_bert_config.json": "5ea26221ce733ace29a3897360e7c6ac8816b2ca0f7306657d69e594fece7325",
    "special_tokens_map.json": "2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397",
    "tokenizer.json": "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e",
    "tokenizer.model": "1299c11d7cf632ef3b4e11937501358ada021bbdf7c47638d13c0ee982f2e79c",
    "tokenizer_config.json": "9076840490613047bc9115963ee96b7702018b0d26ba644240bf856efda93118",
}
OUTTYPES = {"bf16": "BF16", "q8_0": "Q8_0", "q4_0": "Q4_0"}


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fabric", required=True, type=Path, help="qvac-fabric-llm.cpp checkout")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--outtype", action="append", choices=list(OUTTYPES),
                        help="Repeat for several files; default: all of them")
    parser.add_argument("--quantize", type=Path, help="Fabric's llama-quantize, required for q4_0")
    parser.add_argument("--repo", choices=sorted(REVISIONS), default="google/embeddinggemma-300m",
                        help="Source repository; google needs a Hugging Face login with Gemma access")
    return parser.parse_args()


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def download(repo, directory):
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import GatedRepoError

    for name, digest in FILES.items():
        path = directory / name
        if path.exists() and sha256(path) == digest:
            continue
        try:
            hf_hub_download(repo, name, revision=REVISIONS[repo], local_dir=directory)
        except GatedRepoError as error:
            raise PermissionError(f"{repo} is gated; log in with an account that accepted the Gemma license "
                                  "(HF_TOKEN or `hf auth login`), or pass --repo unsloth/embeddinggemma-300m") from error
        if sha256(path) != digest:
            path.unlink()
            raise ValueError(f"{name} does not match the pinned SHA256")
        print(f"Downloaded {name}")


def verify(gguf, path):
    reader = gguf.GGUFReader(path)
    architecture = reader.fields["general.architecture"].contents()
    shapes = {tensor.name: [int(n) for n in tensor.shape] for tensor in reader.tensors}
    if architecture != "gemma-embedding":
        raise ValueError(f"{path.name}: unexpected architecture {architecture}")
    if shapes.get("dense_2.weight") != [768, 3072] or shapes.get("dense_3.weight") != [3072, 768]:
        raise ValueError(f"{path.name}: Dense layers are missing or have unexpected shapes")
    return len(shapes)


def convert(args):
    fabric = args.fabric.resolve(strict=True)
    converter = fabric / "convert_hf_to_gguf.py"
    sys.path.insert(0, str(fabric / "gguf-py"))
    import gguf

    outtypes = args.outtype or list(OUTTYPES)
    quantize = args.quantize.resolve(strict=True) if args.quantize else None
    if "q4_0" in outtypes and quantize is None:
        raise ValueError("q4_0 needs --quantize pointing to Fabric's llama-quantize")
    outputs = {outtype: args.output_dir / f"embeddinggemma-300M-{OUTTYPES[outtype]}.gguf" for outtype in outtypes}
    for output in outputs.values():
        if output.exists():
            raise FileExistsError(f"Output already exists: {output}")
    # The directory name becomes general.name in the GGUF metadata.
    source = args.output_dir / "source" / "embeddinggemma-300m"
    download(args.repo, source)

    def run_converter(outtype, outfile):
        subprocess.run([sys.executable, str(converter), str(source), "--outtype", outtype,
                        "--sentence-transformers-dense-modules", "--outfile", str(outfile)], check=True)

    for outtype, output in outputs.items():
        temporary = output.with_name(output.name + ".tmp")
        intermediate = output.with_name(output.name + ".f32.tmp")
        try:
            if outtype == "q4_0":
                # The converter cannot write Q4_0. Keep the token embedding at Q8_0, like the files this replaces.
                run_converter("f32", intermediate)
                subprocess.run([str(quantize), "--token-embedding-type", "q8_0", str(intermediate), str(temporary),
                                "Q4_0"], check=True)
            else:
                run_converter(outtype, temporary)
            tensors = verify(gguf, temporary)
            temporary.rename(output)
        finally:
            temporary.unlink(missing_ok=True)
            intermediate.unlink(missing_ok=True)
        print(f"Created {output} ({tensors} tensors, {output.stat().st_size} bytes, sha256 {sha256(output)})")


if __name__ == "__main__":
    convert(arguments())
