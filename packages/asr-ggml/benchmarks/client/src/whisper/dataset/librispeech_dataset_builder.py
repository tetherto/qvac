# coding=utf-8
# Copyright 2021 The TensorFlow Datasets Authors and the HuggingFace Datasets Authors.
#
# This is a modified version of the original Librispeech dataset builder.
# It is used to load the Librispeech dataset with only test splits.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Lint as: python3
"""Librispeech automatic speech recognition dataset."""


import os

import datasets


_CITATION = """\
@inproceedings{panayotov2015librispeech,
  title={Librispeech: an ASR corpus based on public domain audio books},
  author={Panayotov, Vassil and Chen, Guoguo and Povey, Daniel and Khudanpur, Sanjeev},
  booktitle={Acoustics, Speech and Signal Processing (ICASSP), 2015 IEEE International Conference on},
  pages={5206--5210},
  year={2015},
  organization={IEEE}
}
"""

_DESCRIPTION = """\
LibriSpeech is a corpus of approximately 1000 hours of read English speech with sampling rate of 16 kHz,
prepared by Vassil Panayotov with the assistance of Daniel Povey. The data is derived from read
audiobooks from the LibriVox project, and has been carefully segmented and aligned.87
"""

_URL = "http://www.openslr.org/12"
_DL_URL = "http://www.openslr.org/resources/12/"


_DL_URLS = {
    "clean": {
        "test": _DL_URL + "test-clean.tar.gz",
    },
    "other": {
        "test": _DL_URL + "test-other.tar.gz",
    },
    "all": {
        "test.clean": _DL_URL + "test-clean.tar.gz",
        "test.other": _DL_URL + "test-other.tar.gz",
    },
}


class LibrispeechASRConfig(datasets.BuilderConfig):
    """BuilderConfig for LibriSpeechASR."""

    def __init__(self, **kwargs):
        """
        Args:
          data_dir: `string`, the path to the folder containing the files in the
            downloaded .tar
          citation: `string`, citation for the data set
          url: `string`, url for information about the data set
          **kwargs: keyword arguments forwarded to super.
        """
        super(LibrispeechASRConfig, self).__init__(
            version=datasets.Version("2.1.0", ""), **kwargs
        )


class LibrispeechASR(datasets.GeneratorBasedBuilder):
    """Librispeech dataset."""

    DEFAULT_WRITER_BATCH_SIZE = 256
    DEFAULT_CONFIG_NAME = "all"
    BUILDER_CONFIGS = [
        LibrispeechASRConfig(name="clean", description="'Clean' speech."),
        LibrispeechASRConfig(
            name="other", description="'Other', more challenging, speech."
        ),
        LibrispeechASRConfig(
            name="all", description="Combined clean and other dataset."
        ),
    ]

    def _info(self):
        return datasets.DatasetInfo(
            description=_DESCRIPTION,
            features=datasets.Features(
                {
                    "file": datasets.Value("string"),
                    "audio": datasets.Audio(sampling_rate=16_000),
                    "text": datasets.Value("string"),
                    "speaker_id": datasets.Value("int64"),
                    "chapter_id": datasets.Value("int64"),
                    "id": datasets.Value("string"),
                }
            ),
            supervised_keys=("file", "text"),
            homepage=_URL,
            citation=_CITATION,
        )

    def _split_generators(self, dl_manager):
        archive_path = dl_manager.download(_DL_URLS[self.config.name])
        # (Optional) In non-streaming mode, we can extract the archive locally to have actual local audio files:
        local_extracted_archive = (
            dl_manager.extract(archive_path) if not dl_manager.is_streaming else {}
        )

        if self.config.name == "clean":
            test_splits = [
                datasets.SplitGenerator(
                    name=datasets.Split.TEST,
                    gen_kwargs={
                        "local_extracted_archive": local_extracted_archive.get("test"),
                        "files": dl_manager.iter_archive(archive_path["test"]),
                    },
                )
            ]
        elif self.config.name == "other":
            test_splits = [
                datasets.SplitGenerator(
                    name=datasets.Split.TEST,
                    gen_kwargs={
                        "local_extracted_archive": local_extracted_archive.get("test"),
                        "files": dl_manager.iter_archive(archive_path["test"]),
                    },
                )
            ]
        elif self.config.name == "all":
            test_splits = [
                datasets.SplitGenerator(
                    name="test.clean",
                    gen_kwargs={
                        "local_extracted_archive": local_extracted_archive.get(
                            "test.clean"
                        ),
                        "files": dl_manager.iter_archive(archive_path["test.clean"]),
                    },
                ),
                datasets.SplitGenerator(
                    name="test.other",
                    gen_kwargs={
                        "local_extracted_archive": local_extracted_archive.get(
                            "test.other"
                        ),
                        "files": dl_manager.iter_archive(archive_path["test.other"]),
                    },
                ),
            ]

        return test_splits

    def _generate_examples(self, files, local_extracted_archive):
        """Generate examples from a LibriSpeech archive_path."""
        key = 0
        audio_data = {}
        transcripts = []
        for path, f in files:
            if path.endswith(".flac"):
                id_ = path.split("/")[-1][: -len(".flac")]
                audio_data[id_] = f.read()
            elif path.endswith(".trans.txt"):
                for line in f:
                    if line:
                        line = line.decode("utf-8").strip()
                        id_, transcript = line.split(" ", 1)
                        audio_file = f"{id_}.flac"
                        speaker_id, chapter_id = [int(el) for el in id_.split("-")[:2]]
                        audio_file = (
                            os.path.join(local_extracted_archive, audio_file)
                            if local_extracted_archive
                            else audio_file
                        )
                        transcripts.append(
                            {
                                "id": id_,
                                "speaker_id": speaker_id,
                                "chapter_id": chapter_id,
                                "file": audio_file,
                                "text": transcript,
                            }
                        )
            if audio_data and len(audio_data) == len(transcripts):
                for transcript in transcripts:
                    audio = {
                        "path": transcript["file"],
                        "bytes": audio_data[transcript["id"]],
                    }
                    yield key, {"audio": audio, **transcript}
                    key += 1
                audio_data = {}
                transcripts = []
