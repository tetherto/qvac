"""AISHELL-4 Test Dataset Loading Script for Hugging Face Datasets with VAD Ground Truth

This script loads the test dataset from AISHELL-4: A Free Mandarin Multi-channel
Meeting Speech Corpus from OpenSLR 111, including Voice Activity Detection ground truth.

Dataset URL: https://www.openslr.org/111/
"""

import json
import numpy as np
from pathlib import Path
from typing import List, Generator, Dict, Tuple, Optional
import datasets
from datasets import DownloadManager, DatasetInfo, Features, Audio, Value, Split, SplitGenerator, Sequence

_CITATION = """
@inproceedings{AISHELL-4_2021,
    title={AISHELL-4: An Open Source Dataset for Speech Enhancement, Separation, Recognition and Speaker Diarization in Conference Scenario},
    author={Yihui Fu, Luyao Cheng, Shubo Lv, Yukai Jv, Yuxiang Kong, Zhuo Chen, Yanxin Hu, Lei Xie, Jian Wu, Hui Bu, Xin Xu, Jun Du, Jingdong Chen},
    booktitle={Interspeech},
    url={https://arxiv.org/abs/2104.03603},
    year={2021}
}
"""

_DESCRIPTION = """
AISHELL-4 is a sizable real-recorded Mandarin speech dataset collected by 8-channel circular microphone array 
for speech enhancement, separation, recognition and speaker diarization research. The dataset consists of 
211 recorded meeting sessions, each containing 4 to 8 speakers, with a total length of 120 hours. 
This loader includes Voice Activity Detection (VAD) ground truth extracted from TextGrid/RTTM annotations.
"""

_HOMEPAGE = "https://www.openslr.org/111/"
_LICENSE = "CC BY-SA 4.0"

# URLs for the test dataset with mirrors
_URLS = {
    "test": {
        "main": "https://www.openslr.org/resources/111/test.tar.gz",
        "mirrors": {
            "us": "https://us.openslr.org/resources/111/test.tar.gz",
            "eu": "https://openslr.elda.org/resources/111/test.tar.gz",
            "cn": "https://openslr.magicdatatech.com/resources/111/test.tar.gz"
        }
    }
}


class Aishell4TestConfig(datasets.BuilderConfig):
    """BuilderConfig for AISHELL-4 Test dataset."""

    def __init__(self, vad_frame_rate: float = 32.0, **kwargs):
        """
        Args:
            vad_frame_rate: Frame rate for VAD labels in Hz (default: 32 Hz = 31.25ms frames)
        """
        super().__init__(**kwargs)
        self.vad_frame_rate = vad_frame_rate


class Aishell4Test(datasets.GeneratorBasedBuilder):
    """AISHELL-4 Test Dataset Builder with VAD Ground Truth"""

    BUILDER_CONFIGS = [
        Aishell4TestConfig(
            name="test",
            version=datasets.Version("1.0.0"),
            description="AISHELL-4 test dataset with multi-channel audio, transcriptions, and VAD ground truth (31.25ms frames)",
            vad_frame_rate=32.0
        ),
    ]

    DEFAULT_CONFIG_NAME = "test"

    def _info(self) -> DatasetInfo:
        """Dataset info with features schema including VAD"""
        features = Features({
            "session_id": Value("string"),
            "audio_path": Value("string"),
            "audio": Audio(sampling_rate=16000),  # AISHELL-4 uses 16kHz sampling rate
            "channel": Value("int32"),  # Channel number (0-7 for 8-channel array)
            "duration": Value("float32"),
            "transcription": Value("string"),
            "speaker_id": Value("string"),
            "room_type": Value("string"),
            "start_time": Value("float32"),
            "end_time": Value("float32"),
            # VAD ground truth features
            "vad_labels": Sequence(Value("int32")),  # Frame-level VAD labels (0=silence, 1=speech)
            "vad_timestamps": Sequence(Value("float32")),  # Timestamp for each VAD frame
            "speech_segments": Sequence({  # Continuous speech segments
                "start": Value("float32"),
                "end": Value("float32"),
                "speaker": Value("string"),
                "duration": Value("float32")
            }),
            "vad_frame_rate": Value("float32"),  # Frame rate used for VAD labels
        })

        return DatasetInfo(
            description=_DESCRIPTION,
            features=features,
            homepage=_HOMEPAGE,
            license=_LICENSE,
            citation=_CITATION,
        )

    def _split_generators(self, dl_manager: DownloadManager) -> List[SplitGenerator]:
        """Download and extract the dataset"""

        # Try to download from main URL first, then fallback to mirrors
        urls_to_try = [_URLS["test"]["main"]] + list(_URLS["test"]["mirrors"].values())

        downloaded_path = None
        for url in urls_to_try:
            try:
                downloaded_path = dl_manager.download(url)
                break
            except Exception as e:
                print(f"Failed to download from {url}: {e}")
                continue

        if downloaded_path is None:
            raise RuntimeError("Failed to download dataset from all available URLs")

        # Extract the tar.gz file
        extracted_path = dl_manager.extract(downloaded_path)

        return [
            SplitGenerator(
                name=Split.TEST,
                gen_kwargs={
                    "data_dir": extracted_path,
                    "split": "test"
                }
            )
        ]

    def _generate_examples(self, data_dir: str, split: str) -> Generator[tuple, None, None]:
        """Generate examples from the extracted dataset"""

        data_path = Path(data_dir)

        # Look for the test directory (structure may vary)
        test_dirs = list(data_path.glob("**/test*")) + list(data_path.glob("**/Test*"))
        if not test_dirs:
            test_dirs = [data_path]

        test_dir = test_dirs[0]

        # Find all audio files
        audio_extensions = [".wav", ".flac", ".m4a"]
        audio_files = []
        for ext in audio_extensions:
            audio_files.extend(test_dir.rglob(f"*{ext}"))

        # Look for annotation files (TextGrid and RTTM)
        # textgrid_files = list(test_dir.rglob("*.TextGrid")) + list(test_dir.rglob("*.textgrid"))
        rttm_files = list(test_dir.rglob("*.rttm"))
        transcript_files = list(test_dir.rglob("*.txt")) + list(test_dir.rglob("*.json"))

        # Parse annotations
        vad_annotations = self._parse_vad_annotations(rttm_files)
        transcriptions = self._parse_transcriptions(transcript_files)

        # Generate examples
        for idx, audio_file in enumerate(sorted(audio_files)):
            try:
                # Extract information from filename
                filename = audio_file.stem
                session_id = self._extract_session_id(filename)
                channel = self._extract_channel(filename)
                speaker_id = self._extract_speaker_id(filename)
                room_type = self._extract_room_type(str(audio_file))

                # Get transcription if available
                transcription = transcriptions.get(filename, "")

                # Get audio duration (estimate from file if needed)
                duration = self._get_audio_duration(audio_file)

                # Generate VAD labels
                vad_data = self._generate_vad_labels(
                    session_id, duration, vad_annotations, self.config.vad_frame_rate
                )

                example = {
                    "session_id": session_id,
                    "audio_path": str(audio_file),
                    "audio": str(audio_file),
                    "channel": channel,
                    "duration": duration,
                    "transcription": transcription,
                    "speaker_id": speaker_id,
                    "room_type": room_type,
                    "start_time": 0.0,
                    "end_time": duration,
                    # VAD ground truth
                    "vad_labels": vad_data["labels"],
                    "vad_timestamps": vad_data["timestamps"],
                    "speech_segments": vad_data["segments"],
                    "vad_frame_rate": self.config.vad_frame_rate,
                }

                yield idx, example

            except Exception as e:
                print(f"Warning: Could not process audio file {audio_file}: {e}")
                continue

    def _parse_vad_annotations(self, rttm_files: List[Path]) -> Dict:
        """Parse VAD annotations from TextGrid and RTTM files"""
        annotations = {}

        # Parse TextGrid files
        # for tg_file in textgrid_files:
        #     try:
        #         segments = self._parse_textgrid(tg_file)
        #         session_id = self._extract_session_id(tg_file.stem)
        #         if session_id not in annotations:
        #             annotations[session_id] = []
        #         annotations[session_id].extend(segments)
        #     except Exception as e:
        #         print(f"Warning: Could not parse TextGrid {tg_file}: {e}")

        # Parse RTTM files
        for rttm_file in rttm_files:
            try:
                segments = self._parse_rttm(rttm_file)
                session_id = self._extract_session_id(rttm_file.stem)
                if session_id not in annotations:
                    annotations[session_id] = []
                annotations[session_id].extend(segments)
            except Exception as e:
                print(f"Warning: Could not parse RTTM {rttm_file}: {e}")

        return annotations

    def _parse_textgrid(self, textgrid_file: Path) -> List[Dict]:
        """Parse TextGrid file to extract speech segments"""
        segments = []

        try:
            with open(textgrid_file, 'r', encoding='utf-8') as f:
                content = f.read()

            # Simple TextGrid parsing (for more robust parsing, consider using textgrid library)
            lines = content.split('\n')
            in_interval_tier = False
            intervals_section = False

            i = 0
            while i < len(lines):
                line = lines[i].strip()

                if 'class = "IntervalTier"' in line:
                    in_interval_tier = True
                elif in_interval_tier and 'intervals [' in line:
                    intervals_section = True
                elif intervals_section and 'xmin =' in line:
                    # Parse interval
                    try:
                        xmin = float(line.split('=')[1].strip())
                        i += 1
                        xmax = float(lines[i].split('=')[1].strip())
                        i += 1
                        text = lines[i].split('=')[1].strip().strip('"')

                        # Consider non-empty text as speech
                        if text and text not in ['', 'sil', 'silence', '<NA>']:
                            segments.append({
                                'start': xmin,
                                'end': xmax,
                                'speaker': 'speaker',
                                'text': text
                            })
                    except (ValueError, IndexError):
                        pass

                i += 1

        except Exception as e:
            print(f"Error parsing TextGrid {textgrid_file}: {e}")

        return segments

    def _parse_rttm(self, rttm_file: Path) -> List[Dict]:
        """Parse RTTM file to extract speech segments"""
        segments = []

        try:
            with open(rttm_file, 'r', encoding='utf-8') as f:
                for line in f:
                    # print(line)
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue

                    parts = line.split()
                    if len(parts) >= 8 and parts[0] == 'SPEAKER':
                        # RTTM format: SPEAKER <file> <chnl> <tbeg> <tdur> <ortho> <stype> <name> <conf> <slat>
                        start_time = float(parts[3])
                        duration = float(parts[4])
                        end_time = start_time + duration
                        speaker = parts[7] if len(parts) > 7 else 'speaker'

                        segments.append({
                            'start': start_time,
                            'end': end_time,
                            'speaker': speaker,
                            'text': ''
                        })
        except Exception as e:
            print(f"Error parsing RTTM {rttm_file}: {e}")

        return segments

    def _parse_transcriptions(self, transcript_files: List[Path]) -> Dict[str, str]:
        """Parse transcription files"""
        transcriptions = {}

        for transcript_file in transcript_files:
            try:
                if transcript_file.suffix == ".json":
                    with open(transcript_file, 'r', encoding='utf-8') as f:
                        transcript_data = json.load(f)
                        if isinstance(transcript_data, dict):
                            transcriptions.update(transcript_data)
                else:
                    with open(transcript_file, 'r', encoding='utf-8') as f:
                        for line in f:
                            line = line.strip()
                            if line and '\t' in line:
                                parts = line.split('\t', 1)
                                if len(parts) == 2:
                                    audio_id, text = parts
                                    transcriptions[audio_id] = text
            except Exception as e:
                print(f"Warning: Could not parse transcript file {transcript_file}: {e}")

        return transcriptions

    def _generate_vad_labels(self, session_id: str, duration: float,
                           annotations: Dict, frame_rate: float) -> Dict:
        """Generate frame-level VAD labels from speech segments"""

        # Get segments for this session
        segments = annotations.get(session_id, [])

        # Calculate frame parameters
        frame_duration = 1.0 / frame_rate  # Duration of each frame in seconds
        num_frames = int(np.ceil(duration * frame_rate))

        # Initialize labels as silence (0)
        vad_labels = np.zeros(num_frames, dtype=np.int32)
        timestamps = np.arange(num_frames) * frame_duration

        # Mark speech regions
        for segment in segments:
            start_frame = int(segment['start'] * frame_rate)
            end_frame = int(segment['end'] * frame_rate)

            # Clip to valid range
            start_frame = max(0, start_frame)
            end_frame = min(num_frames, end_frame)

            # Mark as speech (1)
            vad_labels[start_frame:end_frame] = 1

        # Create speech segments list
        speech_segments = []
        for segment in segments:
            speech_segments.append({
                'start': segment['start'],
                'end': segment['end'],
                'speaker': segment.get('speaker', 'unknown'),
                'duration': segment['end'] - segment['start']
            })
        return {
            'labels': vad_labels.tolist(),
            'timestamps': timestamps.tolist(),
            'segments': speech_segments
        }

    def _get_audio_duration(self, audio_file: Path) -> float:
        """Get audio duration (fallback estimation if librosa not available)"""
        import librosa
        y, sr = librosa.load(str(audio_file), sr=None)
        return len(y) / sr

    def _extract_session_id(self, filename: str) -> str:
        """Extract session ID from filename"""
        parts = filename.split('_')
        if len(parts) >= 2:
            return f"{parts[0]}_{parts[1]}"
        return filename.split('.')[0]

    def _extract_channel(self, filename: str) -> int:
        """Extract channel number from filename"""
        import re
        channel_match = re.search(r'[Cc]h?(\d+)', filename)
        if channel_match:
            return int(channel_match.group(1))

        if '_' in filename:
            parts = filename.split('_')
            for part in parts:
                if part.isdigit() and len(part) <= 2:
                    return int(part) % 8

        return 0

    def _extract_speaker_id(self, filename: str) -> str:
        """Extract speaker ID from filename"""
        import re
        speaker_match = re.search(r'[Ss]p?(\d+)', filename)
        if speaker_match:
            return f"speaker_{speaker_match.group(1)}"

        parts = filename.split('_')
        if len(parts) >= 3:
            return parts[2]

        return "unknown"

    def _extract_room_type(self, filepath: str) -> str:
        """Extract room type from filepath"""
        filepath_lower = filepath.lower()
        if 'large' in filepath_lower or 'l_' in filepath_lower:
            return "large"
        elif 'medium' in filepath_lower or 'm_' in filepath_lower:
            return "medium"
        elif 'small' in filepath_lower or 's_' in filepath_lower:
            return "small"
        else:
            return "unknown"
