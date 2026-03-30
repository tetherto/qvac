import pytest
import numpy as np
from src.whisper.metrics import (
    levenshtein_distance,
    fuzzy_ratio,
    cosine_similarity,
    calculate_syntactic_score,
    calculate_semantic_score,
    calculate_aradiawer,
    calculate_aradiawer_single,
)


class TestLevenshteinDistance:
    """Tests for the Levenshtein distance function."""

    def test_identical_strings(self):
        """Identical strings should have distance 0."""
        assert levenshtein_distance("hello", "hello") == 0
        assert levenshtein_distance("", "") == 0
        assert levenshtein_distance("test", "test") == 0

    def test_empty_string(self):
        """Distance to empty string equals length of other string."""
        assert levenshtein_distance("hello", "") == 5
        assert levenshtein_distance("", "world") == 5
        assert levenshtein_distance("abc", "") == 3

    def test_single_insertion(self):
        """Single character insertion should have distance 1."""
        assert levenshtein_distance("hello", "helloo") == 1
        assert levenshtein_distance("cat", "cats") == 1

    def test_single_deletion(self):
        """Single character deletion should have distance 1."""
        assert levenshtein_distance("hello", "helo") == 1
        assert levenshtein_distance("cats", "cat") == 1

    def test_single_substitution(self):
        """Single character substitution should have distance 1."""
        assert levenshtein_distance("hello", "hallo") == 1
        assert levenshtein_distance("cat", "bat") == 1

    def test_multiple_edits(self):
        """Multiple edits should accumulate correctly."""
        assert levenshtein_distance("kitten", "sitting") == 3
        assert levenshtein_distance("saturday", "sunday") == 3

    def test_completely_different_strings(self):
        """Completely different strings have distance equal to max length."""
        assert levenshtein_distance("abc", "xyz") == 3
        assert levenshtein_distance("a", "b") == 1

    def test_case_sensitive(self):
        """Distance calculation is case-sensitive."""
        assert levenshtein_distance("Hello", "hello") == 1
        assert levenshtein_distance("ABC", "abc") == 3

    def test_symmetry(self):
        """Distance should be symmetric."""
        assert levenshtein_distance("abc", "def") == levenshtein_distance("def", "abc")
        assert levenshtein_distance("hello", "world") == levenshtein_distance("world", "hello")


class TestFuzzyRatio:
    """Tests for the fuzzy ratio function."""

    def test_identical_strings(self):
        """Identical strings should have ratio 1.0."""
        assert fuzzy_ratio("hello", "hello") == 1.0
        assert fuzzy_ratio("test", "test") == 1.0

    def test_empty_strings(self):
        """Both empty strings should have ratio 1.0."""
        assert fuzzy_ratio("", "") == 1.0

    def test_one_empty_string(self):
        """One empty string should have ratio 0.0."""
        assert fuzzy_ratio("hello", "") == 0.0
        assert fuzzy_ratio("", "world") == 0.0

    def test_completely_different(self):
        """Completely different strings of same length have lower ratio."""
        ratio = fuzzy_ratio("abc", "xyz")
        # LD = 3 (all chars different), total_len = 6, FR = (6 - 3) / 6 = 0.5
        assert ratio == 0.5

    def test_similar_strings(self):
        """Similar strings should have high ratio."""
        ratio = fuzzy_ratio("hello", "hallo")
        # LD = 1, total_len = 10, FR = (10-1)/10 = 0.9
        assert ratio == 0.9

    def test_ratio_bounds(self):
        """Ratio should always be between 0 and 1."""
        test_pairs = [
            ("a", "b"),
            ("hello", "world"),
            ("test", "testing"),
            ("abc", "abcdef"),
        ]
        for s1, s2 in test_pairs:
            ratio = fuzzy_ratio(s1, s2)
            assert 0.0 <= ratio <= 1.0, f"Ratio {ratio} out of bounds for ({s1}, {s2})"

    def test_formula_correctness(self):
        """Verify the formula: FR = (len(s1) + len(s2) - LD) / (len(s1) + len(s2))."""
        s1, s2 = "kitten", "sitting"
        ld = levenshtein_distance(s1, s2)  # 3
        expected = (len(s1) + len(s2) - ld) / (len(s1) + len(s2))
        assert fuzzy_ratio(s1, s2) == pytest.approx(expected)


class TestCosineSimilarity:
    """Tests for the cosine similarity function."""

    def test_identical_vectors(self):
        """Identical vectors should have similarity 1.0."""
        v = np.array([1.0, 2.0, 3.0])
        assert cosine_similarity(v, v) == pytest.approx(1.0)

    def test_orthogonal_vectors(self):
        """Orthogonal vectors should have similarity 0.0."""
        v1 = np.array([1.0, 0.0, 0.0])
        v2 = np.array([0.0, 1.0, 0.0])
        assert cosine_similarity(v1, v2) == pytest.approx(0.0)

    def test_opposite_vectors(self):
        """Opposite vectors should have similarity -1.0."""
        v1 = np.array([1.0, 2.0, 3.0])
        v2 = np.array([-1.0, -2.0, -3.0])
        assert cosine_similarity(v1, v2) == pytest.approx(-1.0)

    def test_zero_vector(self):
        """Zero vector should return 0.0."""
        v1 = np.array([0.0, 0.0, 0.0])
        v2 = np.array([1.0, 2.0, 3.0])
        assert cosine_similarity(v1, v2) == 0.0
        assert cosine_similarity(v2, v1) == 0.0

    def test_scaled_vectors(self):
        """Scaled vectors should have same similarity (magnitude invariant)."""
        v1 = np.array([1.0, 2.0, 3.0])
        v2 = np.array([2.0, 4.0, 6.0])
        assert cosine_similarity(v1, v2) == pytest.approx(1.0)

    def test_similarity_bounds(self):
        """Similarity should be between -1 and 1."""
        for _ in range(10):
            v1 = np.random.randn(100)
            v2 = np.random.randn(100)
            sim = cosine_similarity(v1, v2)
            assert -1.0 <= sim <= 1.0


class TestSyntacticScore:
    """Tests for the syntactic score calculation."""

    def test_identical_transcripts(self):
        """Identical transcripts should have score 1.0."""
        ref = "hello world test"
        hyp = "hello world test"
        assert calculate_syntactic_score(ref, hyp) == 1.0

    def test_empty_transcripts(self):
        """Both empty transcripts should have score 1.0."""
        assert calculate_syntactic_score("", "") == 1.0
        assert calculate_syntactic_score("  ", "  ") == 1.0

    def test_one_empty_transcript(self):
        """One empty transcript should have score 0.0."""
        assert calculate_syntactic_score("hello", "") == 0.0
        assert calculate_syntactic_score("", "world") == 0.0

    def test_similar_transcripts(self):
        """Similar transcripts should have high score."""
        ref = "hello world"
        hyp = "hallo world"
        score = calculate_syntactic_score(ref, hyp)
        assert 0.9 <= score <= 1.0  # "hello" vs "hallo" is similar

    def test_different_lengths_penalized(self):
        """Different length transcripts should be penalized."""
        ref = "hello world today"
        hyp = "hello world"
        score = calculate_syntactic_score(ref, hyp)
        assert score < 1.0

    def test_completely_different(self):
        """Completely different transcripts have lower scores."""
        ref = "aaa bbb ccc"
        hyp = "xxx yyy zzz"
        score = calculate_syntactic_score(ref, hyp)
        # Each word pair has LD=3 for len=3 strings, FR = (6-3)/6 = 0.5
        assert score <= 0.5

    def test_score_bounds(self):
        """Score should always be between 0 and 1."""
        test_pairs = [
            ("hello world", "hello world"),
            ("abc def", "xyz uvw"),
            ("test", "testing one two three"),
            ("a b c d e", "a"),
        ]
        for ref, hyp in test_pairs:
            score = calculate_syntactic_score(ref, hyp)
            assert 0.0 <= score <= 1.0


class TestSemanticScore:
    """Tests for the semantic score calculation."""

    def test_identical_transcripts(self):
        """Identical transcripts should have score 1.0."""
        ref = "hello world"
        hyp = "hello world"
        assert calculate_semantic_score(ref, hyp) == 1.0

    def test_empty_transcripts(self):
        """Both empty transcripts should have score 1.0."""
        assert calculate_semantic_score("", "") == 1.0

    def test_one_empty_transcript(self):
        """One empty transcript should have score 0.0."""
        assert calculate_semantic_score("hello", "") == 0.0
        assert calculate_semantic_score("", "world") == 0.0

    def test_overlapping_words(self):
        """Transcripts with word overlap should have positive score."""
        ref = "the quick brown fox"
        hyp = "the quick red fox"
        score = calculate_semantic_score(ref, hyp)
        assert 0.5 < score < 1.0

    def test_no_overlap(self):
        """Transcripts with no word overlap have score 0."""
        ref = "hello world"
        hyp = "goodbye universe"
        score = calculate_semantic_score(ref, hyp)
        assert score == 0.0

    def test_case_insensitive(self):
        """Semantic score should be case insensitive."""
        ref = "Hello World"
        hyp = "hello world"
        assert calculate_semantic_score(ref, hyp) == 1.0

    def test_score_bounds(self):
        """Score should always be between 0 and 1."""
        test_pairs = [
            ("hello world", "hello world"),
            ("abc def", "xyz uvw"),
            ("the cat sat", "a cat sits"),
        ]
        for ref, hyp in test_pairs:
            score = calculate_semantic_score(ref, hyp)
            assert 0.0 <= score <= 1.0


class TestAraDiaWER:
    """Tests for the AraDiaWER metric calculation."""

    def test_perfect_prediction(self):
        """Perfect predictions should have AraDiaWER close to 0."""
        predictions = ["hello world", "this is a test"]
        references = ["hello world", "this is a test"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0
        assert sem == 1.0
        assert syn == 1.0

    def test_aradiawer_lower_than_wer(self):
        """AraDiaWER should generally be lower than or equal to WER."""
        predictions = ["hello world today", "this is test"]
        references = ["hello world", "this is a test"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert aradiawer <= wer

    def test_formula_correctness(self):
        """Verify AraDiaWER = WER / (Score_sem + Score_syn)."""
        predictions = ["hello world"]
        references = ["hallo world"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        expected = wer / (sem + syn)
        assert aradiawer == pytest.approx(expected)

    def test_min_threshold_applied(self):
        """Minimum threshold should prevent very low scores."""
        predictions = ["abc xyz"]
        references = ["def uvw"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(
            predictions, references, min_score_threshold=0.5
        )
        
        assert sem >= 0.5
        assert syn >= 0.5

    def test_custom_threshold(self):
        """Custom threshold should be applied correctly."""
        predictions = ["completely different sentence"]
        references = ["nothing alike here at all"]
        
        aradiawer1, _, sem1, syn1 = calculate_aradiawer(
            predictions, references, min_score_threshold=0.3
        )
        aradiawer2, _, sem2, syn2 = calculate_aradiawer(
            predictions, references, min_score_threshold=0.7
        )
        
        # Higher threshold means higher score sum, lower AraDiaWER
        assert sem2 >= sem1 or syn2 >= syn1

    def test_mismatched_lengths_raises(self):
        """Mismatched prediction/reference lengths should raise ValueError."""
        predictions = ["hello", "world"]
        references = ["hello"]
        
        with pytest.raises(ValueError, match="must match"):
            calculate_aradiawer(predictions, references)

    def test_empty_inputs_raises(self):
        """Empty inputs should raise ValueError."""
        with pytest.raises(ValueError, match="cannot be empty"):
            calculate_aradiawer([], [])

    def test_multiple_samples(self):
        """Should correctly handle multiple samples."""
        predictions = [
            "the cat sat on the mat",
            "hello world",
            "this is a test",
        ]
        references = [
            "the cat sat on the mat",
            "hello there world",
            "this was a test",
        ]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert isinstance(aradiawer, float)
        assert isinstance(wer, float)
        assert 0.0 <= sem <= 1.0
        assert 0.0 <= syn <= 1.0

    def test_returns_tuple_of_four(self):
        """Should return a tuple of exactly 4 values."""
        predictions = ["hello"]
        references = ["hello"]
        
        result = calculate_aradiawer(predictions, references)
        
        assert isinstance(result, tuple)
        assert len(result) == 4


class TestAraDiaWERSingle:
    """Tests for the single-sample AraDiaWER convenience function."""

    def test_single_prediction(self):
        """Should work with single prediction/reference pair."""
        prediction = "hello world"
        reference = "hello world"
        
        aradiawer, wer, sem, syn = calculate_aradiawer_single(prediction, reference)
        
        assert wer == 0.0
        assert aradiawer == 0.0
        assert sem == 1.0
        assert syn == 1.0

    def test_matches_batch_version(self):
        """Single version should match batch version with one sample."""
        prediction = "hello world today"
        reference = "hello world"
        
        single_result = calculate_aradiawer_single(prediction, reference)
        batch_result = calculate_aradiawer([prediction], [reference])
        
        assert single_result == batch_result

    def test_threshold_parameter(self):
        """Should accept min_score_threshold parameter."""
        prediction = "abc"
        reference = "xyz"
        
        result = calculate_aradiawer_single(
            prediction, reference, min_score_threshold=0.6
        )
        
        _, _, sem, syn = result
        assert sem >= 0.6
        assert syn >= 0.6


class TestAraDiaWEREdgeCases:
    """Edge case tests for AraDiaWER."""

    def test_whitespace_handling(self):
        """Should handle extra whitespace correctly."""
        predictions = ["hello  world"]
        references = ["hello world"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert isinstance(aradiawer, float)

    def test_unicode_arabic(self):
        """Should handle Arabic Unicode text."""
        predictions = ["مرحبا بالعالم"]
        references = ["مرحبا بالعالم"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0

    def test_mixed_scripts(self):
        """Should handle mixed Arabic and English."""
        predictions = ["hello مرحبا world"]
        references = ["hello مرحبا world"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0

    def test_punctuation(self):
        """Should handle punctuation in transcripts."""
        predictions = ["hello, world!"]
        references = ["hello world"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert isinstance(aradiawer, float)

    def test_single_word(self):
        """Should handle single-word transcripts."""
        predictions = ["hello"]
        references = ["hello"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0

    def test_very_long_transcript(self):
        """Should handle very long transcripts."""
        words = ["word"] * 1000
        predictions = [" ".join(words)]
        references = [" ".join(words)]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0


class TestAraDiaWERPaperExamples:
    """Tests based on examples from the AraDiaWER paper."""

    def test_reduction_from_wer(self):
        """AraDiaWER should show reduction from WER for similar transcripts.
        
        The paper reports an average 18.65% reduction in error interpretation
        compared to WER for semantically/syntactically similar transcripts.
        """
        # Simulate a case where hypothesis is semantically similar but has word errors
        predictions = ["the cat sat on a mat"]
        references = ["the cat sits on the mat"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        # AraDiaWER should be lower than WER due to semantic/syntactic similarity
        assert aradiawer < wer
        # The scores should reflect partial similarity
        assert sem > 0.5
        assert syn > 0.5

    def test_score_sum_greater_than_one(self):
        """When transcripts align well, Score_sem + Score_syn should exceed 1.
        
        This causes WER to be divided by a value > 1, reducing AraDiaWER.
        """
        predictions = ["hello world friend"]
        references = ["hello world friend"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert (sem + syn) >= 1.0

    def test_dialectal_variation_tolerance(self):
        """Should be tolerant of dialectal variations that preserve meaning.
        
        The metric is designed to be "forgiving" of errors that preserve
        semantic or structural meaning.
        """
        # Simulated dialectal variation
        predictions = ["i am going to the store"]
        references = ["i'm going to the store"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        # Semantic similarity should be positive (shared words: i, going, to, the, store)
        # Using word-based fallback, Jaccard = 5/7 ≈ 0.57 (without MiniLM embeddings)
        assert sem > 0.5
        # AraDiaWER should still reduce the raw WER
        assert aradiawer <= wer


class TestAraDiaWERArabicText:
    """Tests using real Arabic text for AraDiaWER metric.
    
    AraDiaWER is specifically designed for Dialectical Arabic ASR evaluation,
    with initial validation on Egyptian Arabic dialect.
    """

    def test_identical_arabic_sentence(self):
        """Perfect match with Arabic sentence should give zero error."""
        # "Hello, how are you?" in Arabic
        predictions = ["مرحبا كيف حالك"]
        references = ["مرحبا كيف حالك"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0
        assert sem == 1.0
        assert syn == 1.0

    def test_arabic_with_minor_variation(self):
        """Similar Arabic sentences should have high similarity scores."""
        # Reference: "The weather today is beautiful"
        # Prediction: "The weather today is very beautiful" (added word)
        predictions = ["الطقس اليوم جميل جدا"]
        references = ["الطقس اليوم جميل"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        # WER should be > 0 due to the extra word
        assert wer > 0
        # Syntactic score should be high (3/4 words match exactly)
        assert syn > 0.5
        # AraDiaWER should reduce the raw WER
        assert aradiawer <= wer

    def test_egyptian_dialect_greeting(self):
        """Test with Egyptian Arabic dialect examples."""
        # Egyptian: "How are you?" - إزيك (izzayak) vs MSA: كيف حالك
        predictions = ["ازيك عامل ايه"]  # "How are you, how are you doing?"
        references = ["ازيك عامل ايه"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0

    def test_arabic_dialectal_variation_egyptian(self):
        """Test Egyptian dialect variation handling.
        
        Egyptian Arabic often differs from MSA in vocabulary and pronunciation.
        """
        # "I want to go to the market"
        # MSA-like: أريد أن أذهب إلى السوق
        # Egyptian: عايز اروح السوق
        predictions = ["عايز اروح السوق"]
        references = ["اريد الذهاب الى السوق"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        # These are semantically similar but lexically different
        # WER will be high, but AraDiaWER should be more forgiving
        assert isinstance(aradiawer, float)
        assert isinstance(wer, float)

    def test_arabic_common_asr_errors(self):
        """Test common ASR errors in Arabic transcription.
        
        ASR systems often confuse similar-sounding Arabic letters.
        """
        # Common confusion: ح (ḥ) vs ه (h), ع (ʿ) vs ا (a)
        # "Good morning" with slight variation
        predictions = ["صباح الخير يا صديقي"]  # "Good morning my friend"
        references = ["صباح الخير يا صديقي"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0

    def test_arabic_with_diacritics_variation(self):
        """Test Arabic text with/without diacritics (tashkeel).
        
        Arabic diacritics (harakat) are often omitted in casual writing
        and ASR output may vary in their presence.
        """
        # With some diacritics vs without
        # "The book" - الكتاب
        predictions = ["الكتاب الجديد"]  # "The new book"
        references = ["الكتاب الجديد"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert sem == 1.0

    def test_arabic_numbers_mixed(self):
        """Test Arabic text with numbers."""
        # "I have 5 books"
        predictions = ["عندي خمسة كتب"]
        references = ["عندي خمسة كتب"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0

    def test_arabic_partial_word_match(self):
        """Test partial word matching in Arabic.
        
        Arabic morphology is complex - similar roots should score higher
        than completely different words.
        """
        # Similar root ك-ت-ب (k-t-b) for "write/book"
        # كتاب (book) vs كاتب (writer) - same root, different form
        predictions = ["الكاتب"]  # "the writer"
        references = ["الكتاب"]  # "the book"
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        # Words share the same root, so syntactic score should reflect similarity
        assert syn > 0.5  # Fuzzy matching should catch the similarity

    def test_arabic_sentence_word_order(self):
        """Test Arabic with different word order.
        
        Arabic allows flexible word order (VSO, SVO, etc.)
        """
        # "Ahmed went to school"
        predictions = ["ذهب أحمد إلى المدرسة"]  # VSO order
        references = ["أحمد ذهب إلى المدرسة"]  # SVO order
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        # Same words, different order - semantic similarity should be high
        assert sem > 0.5
        # WER will penalize word order changes
        assert wer > 0

    def test_arabic_multiple_samples(self):
        """Test batch processing with multiple Arabic samples."""
        predictions = [
            "مرحبا",  # "Hello"
            "شكرا جزيلا",  # "Thank you very much"
            "مع السلامة",  # "Goodbye"
        ]
        references = [
            "مرحبا",
            "شكرا جزيلا",
            "مع السلامة",
        ]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0
        assert sem == 1.0
        assert syn == 1.0

    def test_arabic_long_sentence(self):
        """Test with a longer Arabic sentence."""
        # "The Arabic language is one of the most beautiful languages in the world"
        predictions = ["اللغة العربية من أجمل اللغات في العالم"]
        references = ["اللغة العربية من أجمل اللغات في العالم"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0

    def test_arabic_gulf_dialect(self):
        """Test with Gulf Arabic dialect example."""
        # Gulf: شلونك (shlonak) = "How are you?"
        predictions = ["شلونك اليوم"]  # "How are you today?"
        references = ["شلونك اليوم"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0

    def test_arabic_levantine_dialect(self):
        """Test with Levantine (Shami) Arabic dialect example."""
        # Levantine: كيفك (kifak) = "How are you?"
        predictions = ["كيفك شو عم تعمل"]  # "How are you, what are you doing?"
        references = ["كيفك شو عم تعمل"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        assert wer == 0.0
        assert aradiawer == 0.0

    def test_aradiawer_reduces_wer_for_similar_arabic(self):
        """Verify AraDiaWER reduces error rate for semantically similar Arabic.
        
        This is the key property of AraDiaWER - it should be more forgiving
        than raw WER for transcripts that preserve meaning.
        """
        # Similar meaning, slight word variation
        # "I love reading books" with variation
        predictions = ["أحب قراءة الكتب كثيرا"]  # Added "a lot"
        references = ["أحب قراءة الكتب"]
        
        aradiawer, wer, sem, syn = calculate_aradiawer(predictions, references)
        
        # WER should be positive (there's an extra word)
        assert wer > 0
        # AraDiaWER should be less than or equal to WER
        assert aradiawer <= wer
        # The reduction factor (sem + syn) should be >= 1
        assert (sem + syn) >= 1.0


@pytest.mark.verbose_arabic
class TestAraDiaWERVerboseArabic:
    """Verbose Arabic phrase tests that print detailed metric results.
    
    These tests are skipped by default. To run them explicitly:
    
        pytest tests/test_metrics.py::TestAraDiaWERVerboseArabic -v -s -m verbose_arabic
        
    Or use the run function directly:
    
        cd benchmarks/client
        python -c "from tests.test_metrics import run_verbose_arabic_test; run_verbose_arabic_test()"
    """

    def test_verbose_arabic_phrases_comparison(self):
        """Print detailed AraDiaWER metrics for various Arabic dialect phrases.
        
        Run with: pytest tests/test_metrics.py -k "verbose_arabic" -v -s
        """
        # Collection of Arabic phrases with their English meanings
        # Format: (reference, prediction, english_meaning, dialect_note)
        arabic_phrases = [
            # Egyptian Arabic
            (
                "ازيك عامل ايه",
                "ازيك عامل ايه",
                "How are you? What's up?",
                "Egyptian Arabic (exact match)"
            ),
            (
                "انا رايح السوق",
                "انا رايح السوق دلوقتي",
                "I'm going to the market / I'm going to the market now",
                "Egyptian Arabic (added 'now')"
            ),
            (
                "الاكل ده لذيذ اوي",
                "الاكل لذيذ",
                "This food is very delicious / The food is delicious",
                "Egyptian Arabic (simplified)"
            ),
            
            # Gulf Arabic
            (
                "شلونك اليوم",
                "شلونك اليوم",
                "How are you today?",
                "Gulf Arabic (exact match)"
            ),
            (
                "وين رايح",
                "وين انت رايح",
                "Where are you going? / Where you going?",
                "Gulf Arabic (added 'you')"
            ),
            
            # Levantine Arabic (Shami)
            (
                "كيفك شو عم تعمل",
                "كيفك شو عم تعمل",
                "How are you? What are you doing?",
                "Levantine Arabic (exact match)"
            ),
            (
                "بدي روح عالبيت",
                "بدي اروح على البيت",
                "I want to go home",
                "Levantine Arabic (spelling variation)"
            ),
            
            # Modern Standard Arabic (MSA)
            (
                "السلام عليكم ورحمة الله وبركاته",
                "السلام عليكم ورحمة الله",
                "Peace be upon you and God's mercy and blessings",
                "MSA greeting (truncated)"
            ),
            (
                "اللغة العربية جميلة جدا",
                "اللغة العربية جميلة",
                "The Arabic language is very beautiful / is beautiful",
                "MSA (removed 'very')"
            ),
            
            # Common phrases across dialects
            (
                "شكرا جزيلا",
                "شكرا",
                "Thank you very much / Thank you",
                "Common Arabic (simplified)"
            ),
            (
                "مع السلامة",
                "مع السلامه",
                "Goodbye (with peace)",
                "Common Arabic (spelling: ة vs ه)"
            ),
            (
                "ان شاء الله",
                "انشالله",
                "God willing",
                "Common Arabic (contracted form)"
            ),
            
            # Numbers and time
            (
                "الساعة ثلاثة",
                "الساعه تلاته",
                "It's 3 o'clock",
                "MSA vs Colloquial (number pronunciation)"
            ),
            
            # Food-related
            (
                "اريد فنجان قهوة",
                "عايز فنجان قهوة",
                "I want a cup of coffee",
                "MSA 'اريد' vs Egyptian 'عايز'"
            ),
        ]
        
        print("\n" + "=" * 100)
        print("AraDiaWER METRIC EVALUATION - ARABIC DIALECT PHRASES")
        print("=" * 100)
        print(f"{'Dialect/Note':<40} | {'WER':>8} | {'AraDia':>8} | {'Sem':>6} | {'Syn':>6} | {'Reduction':>10}")
        print("-" * 100)
        
        total_wer = 0
        total_aradiawer = 0
        count = 0
        
        for ref, pred, english, dialect_note in arabic_phrases:
            aradiawer, wer, sem, syn = calculate_aradiawer_single(pred, ref)
            
            reduction = ((wer - aradiawer) / wer * 100) if wer > 0 else 0
            
            print(f"{dialect_note:<40} | {wer:>7.2f}% | {aradiawer:>7.2f}% | {sem:>6.3f} | {syn:>6.3f} | {reduction:>9.1f}%")
            print(f"  Reference:  {ref}")
            print(f"  Prediction: {pred}")
            print(f"  English:    {english}")
            print("-" * 100)
            
            total_wer += wer
            total_aradiawer += aradiawer
            count += 1
        
        avg_wer = total_wer / count
        avg_aradiawer = total_aradiawer / count
        avg_reduction = ((avg_wer - avg_aradiawer) / avg_wer * 100) if avg_wer > 0 else 0
        
        print("\nSUMMARY")
        print("=" * 100)
        print(f"Total phrases evaluated: {count}")
        print(f"Average WER:            {avg_wer:.2f}%")
        print(f"Average AraDiaWER:      {avg_aradiawer:.2f}%")
        print(f"Average Reduction:      {avg_reduction:.1f}%")
        print("=" * 100)
        
        # Basic assertions to ensure the test ran
        assert count == len(arabic_phrases)
        assert avg_aradiawer <= avg_wer


# Standalone function to run verbose test without pytest
def run_verbose_arabic_test():
    """Run the verbose Arabic test directly without pytest.
    
    Usage:
        cd benchmarks/client
        python -c "from tests.test_metrics import run_verbose_arabic_test; run_verbose_arabic_test()"
    """
    test_instance = TestAraDiaWERVerboseArabic()
    # Remove the skip marker temporarily
    test_instance.test_verbose_arabic_phrases_comparison()
