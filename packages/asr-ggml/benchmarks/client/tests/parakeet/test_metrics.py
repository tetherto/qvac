import pytest
from src.parakeet.metrics import calculate_wer, calculate_cer, summarize_first_partial_latency


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


class TestFirstPartialLatency:
    def test_empty_latencies_summarize_to_none(self):
        assert summarize_first_partial_latency([]) is None

    def test_average_and_median(self):
        summary = summarize_first_partial_latency([100.0, 200.0, 600.0])
        assert summary["avg_ms"] == 300.0
        assert summary["median_ms"] == 200.0
