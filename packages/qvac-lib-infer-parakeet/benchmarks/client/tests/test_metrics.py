import pytest
from src.parakeet.metrics import calculate_wer, calculate_cer


class TestWER:
    def test_identical_strings(self):
        predictions = ["hello world", "this is a test"]
        references = ["hello world", "this is a test"]
        wer = calculate_wer(predictions, references)
        assert wer == 0.0

    def test_completely_different_strings(self):
        predictions = ["hello world"]
        references = ["goodbye universe"]
        wer = calculate_wer(predictions, references)
        assert wer == 100.0

    def test_partial_match(self):
        predictions = ["hello world"]
        references = ["hello there"]
        wer = calculate_wer(predictions, references)
        assert 0 < wer < 100


class TestCER:
    def test_identical_strings(self):
        predictions = ["hello"]
        references = ["hello"]
        cer = calculate_cer(predictions, references)
        assert cer == 0.0

    def test_single_character_difference(self):
        predictions = ["hello"]
        references = ["hallo"]
        cer = calculate_cer(predictions, references)
        assert cer > 0
