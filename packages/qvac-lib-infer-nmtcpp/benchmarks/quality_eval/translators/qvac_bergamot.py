"""
QVAC Bergamot Translator wrapper for evaluation framework
Uses qvac-lib-infer-nmtcpp via Bare runtime with Bergamot/Firefox model format
Uses temporary file-based communication to avoid subprocess deadlock
"""

import os
import sys
import subprocess
import tempfile
import time
from pathlib import Path

# Default Firefox translations models directory
DEFAULT_FIREFOX_MODELS_DIR = Path.home() / ".local/share/bergamot/models/firefox"


def translate_direct(texts, src_lang, trg_lang):
    """Translates texts directly from source to target language using QVAC Bergamot

    Args:
        texts: List of strings to translate
        src_lang: Source language code
        trg_lang: Target language code

    Returns:
        List of translated strings
    """

    # QVAC repo directory (where node_modules are located)
    # Navigate up from translators/ -> quality_eval/ -> benchmarks/ -> repo root
    qvac_repo_dir = Path(__file__).parent.parent.parent.parent.resolve()

    # Path to the nmt-cli tool (must be in qvac repo for module resolution)
    script_path = qvac_repo_dir / "nmt-cli"

    if not script_path.exists():
        raise FileNotFoundError(f"QVAC translate script not found: {script_path}")

    # Prepare input: one sentence per line
    input_text = "\n".join(texts)

    # Create temporary files for input and output
    input_fd, input_path = tempfile.mkstemp(suffix=".txt", prefix="qvac_bergamot_input_")
    output_fd, output_path = tempfile.mkstemp(suffix=".txt", prefix="qvac_bergamot_output_")

    try:
        # Write input to temp file
        with os.fdopen(input_fd, 'w') as f:
            f.write(input_text)

        # Close the output file descriptor (we'll write to it via shell redirection)
        os.close(output_fd)

        # Build environment variables for subprocess
        env = os.environ.copy()

        # Get Firefox models directory
        models_dir = env.get("FIREFOX_MODELS_DIR", str(DEFAULT_FIREFOX_MODELS_DIR))

        # Check if batch mode is enabled
        use_batch = os.environ.get("USE_BATCH", "false").lower() == "true"

        # Log translation details
        print(f"[QVAC_BERGAMOT] Starting translation: {src_lang} -> {trg_lang}", file=sys.stderr)
        print(f"[QVAC_BERGAMOT] Input file: {input_path} ({len(texts)} sentences)", file=sys.stderr)
        print(f"[QVAC_BERGAMOT] Output file: {output_path}", file=sys.stderr)
        print(f"[QVAC_BERGAMOT] Models directory: {models_dir}", file=sys.stderr)
        print(f"[QVAC_BERGAMOT] Batch mode: {'ENABLED' if use_batch else 'DISABLED'}", file=sys.stderr)

        # Create temporary file for stderr capture
        stderr_fd, stderr_path = tempfile.mkstemp(suffix=".err", prefix="qvac_bergamot_stderr_")
        os.close(stderr_fd)

        batch_flag = "--batch " if use_batch else ""

        # Build shell command using cat pipe
        # Use --bergamot flag for Bergamot model format and --cpu for CPU inference
        cmd = f"cat {input_path} | bare {script_path} --bergamot {batch_flag} --model-dir {models_dir} --cpu {src_lang} {trg_lang} > {output_path} 2> {stderr_path}"

        print(f"[QVAC_BERGAMOT] Command: {cmd}", file=sys.stderr)
        print(f"[QVAC_BERGAMOT] Stderr will be captured to: {stderr_path}", file=sys.stderr)
        print(f"[QVAC_BERGAMOT] Starting nmt-cli process...", file=sys.stderr)
        sys.stderr.flush()

        # Run the command in background and poll for completion
        proc = subprocess.Popen(
            cmd,
            shell=True,
            cwd=qvac_repo_dir,
            env=env
        )

        print(f"[QVAC_BERGAMOT] Process started (PID: {proc.pid})", file=sys.stderr)

        # Poll the output file until we get all translations (or timeout)
        translations = []
        start_time = time.time()
        last_progress_time = start_time
        last_stderr_check_time = start_time
        timeout = 7200  # 120 minutes (2 hours)
        output_file_found = False
        filtered_lines_count = 0
        last_stderr_line_count = 0

        while time.time() - start_time < timeout:
            # Check if output file has the expected number of lines
            try:
                with open(output_path, 'r') as f:
                    # Filter out debug output lines that nmt-cli prints to stdout
                    debug_prefixes = ("Set ", "Error:", "Detected model type:", "[C++", "[BERGAMOT")
                    all_lines = f.readlines()
                    translations = []
                    filtered_this_iteration = 0

                    for line in all_lines:
                        line_stripped = line.strip()
                        if line_stripped:
                            if line_stripped.startswith(debug_prefixes):
                                filtered_this_iteration += 1
                            else:
                                translations.append(line_stripped)

                    # Track filtered lines (only log if count changes)
                    if filtered_this_iteration != filtered_lines_count:
                        filtered_lines_count = filtered_this_iteration
                        if filtered_lines_count > 0:
                            print(f"[QVAC_BERGAMOT] Filtered {filtered_lines_count} debug lines from output", file=sys.stderr)

                # Log when output file is first created
                if not output_file_found:
                    output_file_found = True
                    print(f"[QVAC_BERGAMOT] Output file created, monitoring for translations...", file=sys.stderr)

                # Print progress every 5 seconds
                current_time = time.time()
                if current_time - last_progress_time >= 5:
                    elapsed = current_time - start_time
                    print(f"[QVAC_BERGAMOT] Progress: {len(translations)}/{len(texts)} lines translated ({elapsed:.1f}s elapsed)", file=sys.stderr)
                    last_progress_time = current_time
                    sys.stderr.flush()

                # Check stderr every 10 seconds for errors or warnings
                if current_time - last_stderr_check_time >= 10:
                    try:
                        with open(stderr_path, 'r') as stderr_file:
                            stderr_lines = stderr_file.readlines()
                            new_lines = stderr_lines[last_stderr_line_count:]
                            if new_lines:
                                print(f"[QVAC_BERGAMOT] === nmt-cli stderr (new {len(new_lines)} lines) ===", file=sys.stderr)
                                for line in new_lines[-20:]:  # Show last 20 new lines
                                    print(f"[QVAC_BERGAMOT]   {line.rstrip()}", file=sys.stderr)
                                last_stderr_line_count = len(stderr_lines)
                    except FileNotFoundError:
                        pass
                    last_stderr_check_time = current_time
                    sys.stderr.flush()

                if len(translations) >= len(texts):
                    # Got all translations, kill the process and break
                    elapsed = time.time() - start_time
                    print(f"[QVAC_BERGAMOT] Translation complete! Received {len(translations)}/{len(texts)} lines in {elapsed:.1f}s", file=sys.stderr)
                    print(f"[QVAC_BERGAMOT] Terminating nmt-cli process (PID: {proc.pid})", file=sys.stderr)
                    proc.kill()
                    proc.wait()
                    print(f"[QVAC_BERGAMOT] Process terminated successfully", file=sys.stderr)
                    break
            except FileNotFoundError:
                # Output file not created yet
                current_time = time.time()
                if current_time - start_time > 30 and not output_file_found:
                    print(f"[QVAC_BERGAMOT] WARNING: Output file not created after 30s. nmt-cli may be loading model...", file=sys.stderr)
                    output_file_found = None  # Prevent repeated warnings

            time.sleep(0.1)  # Wait 100ms before checking again
        else:
            # Timeout reached
            elapsed = time.time() - start_time
            print(f"[QVAC_BERGAMOT] ERROR: Timeout reached after {elapsed:.1f}s", file=sys.stderr)
            print(f"[QVAC_BERGAMOT] Progress at timeout: {len(translations)}/{len(texts)} lines", file=sys.stderr)
            print(f"[QVAC_BERGAMOT] Terminating nmt-cli process (PID: {proc.pid})", file=sys.stderr)
            proc.kill()
            proc.wait()
            print(f"[QVAC_BERGAMOT] Process terminated after timeout", file=sys.stderr)

        # Ensure we got the same number of translations as inputs
        if len(translations) < len(texts):
            # Pad with empty strings if needed
            missing = len(texts) - len(translations)
            print(f"[QVAC_BERGAMOT] WARNING: Missing {missing} translations, padding with empty strings", file=sys.stderr)
            while len(translations) < len(texts):
                translations.append("")
        elif len(translations) > len(texts):
            # Trim extra lines (shouldn't happen)
            extra = len(translations) - len(texts)
            print(f"[QVAC_BERGAMOT] WARNING: Got {extra} extra lines, trimming to {len(texts)}", file=sys.stderr)
            translations = translations[:len(texts)]

        print(f"[QVAC_BERGAMOT] Returning {len(translations)} translations", file=sys.stderr)
        sys.stderr.flush()
        return translations

    except subprocess.TimeoutExpired:
        print(f"[QVAC_BERGAMOT] ERROR: subprocess.TimeoutExpired for {src_lang}->{trg_lang} ({len(texts)} sentences)", file=sys.stderr)
        return [""] * len(texts)
    except Exception as e:
        print(f"[QVAC_BERGAMOT] ERROR: Exception during translation {src_lang}->{trg_lang}: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return [""] * len(texts)
    finally:
        # Clean up temporary files
        try:
            if os.path.exists(input_path):
                os.unlink(input_path)
                print(f"[QVAC_BERGAMOT] Cleaned up input file: {input_path}", file=sys.stderr)
            if os.path.exists(output_path):
                os.unlink(output_path)
                print(f"[QVAC_BERGAMOT] Cleaned up output file: {output_path}", file=sys.stderr)
            if 'stderr_path' in locals() and os.path.exists(stderr_path):
                # Print final stderr content before cleanup
                try:
                    with open(stderr_path, 'r') as f:
                        stderr_content = f.read().strip()
                        if stderr_content:
                            print(f"[QVAC_BERGAMOT] Final nmt-cli stderr ({len(stderr_content)} chars):", file=sys.stderr)
                            # Print last 30 lines
                            for line in stderr_content.split('\n')[-30:]:
                                if line.strip():
                                    print(f"[QVAC_BERGAMOT]   {line}", file=sys.stderr)
                except:
                    pass
                os.unlink(stderr_path)
                print(f"[QVAC_BERGAMOT] Cleaned up stderr file: {stderr_path}", file=sys.stderr)
        except Exception as e:
            print(f"[QVAC_BERGAMOT] Error cleaning up temp files: {e}", file=sys.stderr)


def translate_pivot(texts, src_lang, trg_lang):
    """Translates texts via English pivot (src -> en -> trg)

    Args:
        texts: List of strings to translate
        src_lang: Source language code
        trg_lang: Target language code

    Returns:
        List of translated strings
    """
    print(f"[QVAC_BERGAMOT] ===== PIVOT TRANSLATION: {src_lang} -> en -> {trg_lang} =====", file=sys.stderr)
    print(f"[QVAC_BERGAMOT] Input: {len(texts)} sentences", file=sys.stderr)

    # First translate from source to English
    print(f"[QVAC_BERGAMOT] PIVOT Step 1/2: Translating {src_lang} -> en", file=sys.stderr)
    pivot_start = time.time()
    intermediate_texts = translate_direct(texts, src_lang, "en")
    step1_time = time.time() - pivot_start
    print(f"[QVAC_BERGAMOT] PIVOT Step 1 complete in {step1_time:.1f}s", file=sys.stderr)

    # Then translate from English to target
    print(f"[QVAC_BERGAMOT] PIVOT Step 2/2: Translating en -> {trg_lang}", file=sys.stderr)
    step2_start = time.time()
    final_texts = translate_direct(intermediate_texts, "en", trg_lang)
    step2_time = time.time() - step2_start
    print(f"[QVAC_BERGAMOT] PIVOT Step 2 complete in {step2_time:.1f}s", file=sys.stderr)

    total_time = step1_time + step2_time
    print(f"[QVAC_BERGAMOT] ===== PIVOT TRANSLATION COMPLETE in {total_time:.1f}s =====", file=sys.stderr)

    return final_texts


def translate(texts):
    """Main translation function that decides between direct and pivot translation

    Args:
        texts: List of strings to translate

    Returns:
        List of translated strings
    """
    source = os.environ["SRC"]
    target = os.environ["TRG"]
    use_pivot = os.environ.get("USE_PIVOT", "false").lower() == "true"

    # Check if we should use pivot translation
    if use_pivot and source != "en" and target != "en":
        # Use pivot translation via English
        return translate_pivot(texts, source, target)
    else:
        # Use direct translation
        return translate_direct(texts, source, target)


if __name__ == "__main__":
    # Read from stdin, translate, write to stdout
    # This is used by the evaluation framework
    input_lines = [line.rstrip('\n\r') for line in sys.stdin]

    if not input_lines:
        sys.exit(0)

    translations = translate(input_lines)

    for translation in translations:
        print(translation)
