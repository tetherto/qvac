"""Every example must run after `pip install tetherto-qvac-sdk` and nothing else.

The docs embed these files verbatim and present each as something a reader can
copy into an empty directory and run. A `from _common import ...` resolves
in-repo, where the script's own directory is on `sys.path`, and raises
ModuleNotFoundError for everyone who copies the block out.

Each example is copied alone into a temp directory and executed there, so the
examples directory is off `sys.path`. Only declared dependencies are stubbed
when absent, so this needs no worker and no model download.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
EXAMPLES_DIR = PACKAGE_ROOT / "examples"
RUNNER = PACKAGE_ROOT / "scripts" / "run_isolated_example.py"


def run_isolated(example: Path) -> dict:
    """Copy `example` alone into a temp dir and execute it there."""
    with tempfile.TemporaryDirectory() as tmp:
        copied = Path(tmp) / example.name
        shutil.copyfile(example, copied)

        proc = subprocess.run(
            [sys.executable, str(RUNNER), str(copied)],
            cwd=tmp,
            capture_output=True,
            text=True,
            timeout=60,
        )

    if proc.returncode != 0:
        return {
            "ok": False,
            "kind": "exec-error",
            "detail": f"runner exited {proc.returncode}: {proc.stderr.strip()}",
        }

    try:
        result: dict = json.loads(proc.stdout)
        return result
    except json.JSONDecodeError:
        return {
            "ok": False,
            "kind": "exec-error",
            "detail": f"runner emitted non-JSON: {proc.stdout[:200]}",
        }


def write_case(tmp_path: Path, files: dict[str, str]) -> Path:
    for name, body in files.items():
        (tmp_path / name).write_text(body, encoding="utf-8")
    return tmp_path


# ---------------------------------------------------------------------------
# The real examples directory
# ---------------------------------------------------------------------------


def example_files() -> list[Path]:
    return sorted(EXAMPLES_DIR.glob("*.py"))


def test_examples_directory_is_populated() -> None:
    assert example_files(), f"no examples found in {EXAMPLES_DIR}"


@pytest.mark.parametrize("example", example_files(), ids=lambda p: p.name)
def test_example_runs_standalone(example: Path) -> None:
    result = run_isolated(example)

    if result.get("kind") == "missing-module":
        pytest.fail(
            f"{example.name} imports {result.get('module')!r}, which a reader "
            f"copying this file out of the repo would not have — inline the "
            f"helper instead (see examples/README.md). {result.get('detail')}"
        )

    assert result.get("ok"), f"{example.name}: {result.get('detail')}"


def test_no_shared_helper_module() -> None:
    """A helper left in the directory is a standing invitation to import it."""
    assert not (EXAMPLES_DIR / "_common.py").exists(), (
        "_common.py is back; inline the helper into each example instead "
        "(see examples/README.md)"
    )


# ---------------------------------------------------------------------------
# The isolation runner itself, against synthetic examples
# ---------------------------------------------------------------------------


def test_passes_a_standalone_example(tmp_path: Path) -> None:
    write_case(
        tmp_path,
        {
            "ok.py": (
                "import asyncio\nimport sys\n"
                "from tetherto.qvac_sdk import Client\n\n"
                "async def main():\n    return 0\n\n"
                'if __name__ == "__main__":\n'
                "    sys.exit(asyncio.run(main()))\n"
            )
        },
    )
    assert run_isolated(tmp_path / "ok.py") == {"ok": True}


def test_fails_on_sibling_import(tmp_path: Path) -> None:
    write_case(
        tmp_path,
        {
            "_common.py": "def print_progress(p):\n    pass\n",
            "bad.py": "import sys\nfrom _common import print_progress\n",
        },
    )
    result = run_isolated(tmp_path / "bad.py")
    assert result["kind"] == "missing-module"
    assert result["module"] == "_common"


def test_fails_on_import_of_a_deleted_sibling(tmp_path: Path) -> None:
    # No _common.py anywhere. Stubbing only declared dependencies is what keeps
    # this from being fabricated into a false pass.
    write_case(tmp_path, {"bad.py": "import sys\nfrom _common import print_progress\n"})
    result = run_isolated(tmp_path / "bad.py")
    assert result["kind"] == "missing-module"
    assert result["module"] == "_common"


def test_sibling_after_third_party_is_not_masked(tmp_path: Path) -> None:
    # Why declared packages are stubbed: otherwise a missing tetherto raises
    # first and hides this one.
    write_case(
        tmp_path,
        {
            "_common.py": "x = 1\n",
            "bad.py": "from tetherto.qvac_sdk import Client\nfrom _common import x\n",
        },
    )
    result = run_isolated(tmp_path / "bad.py")
    assert result["kind"] == "missing-module"
    assert result["module"] == "_common"


def test_catches_dynamic_sibling_import(tmp_path: Path) -> None:
    write_case(
        tmp_path,
        {
            "_common.py": "x = 1\n",
            "bad.py": 'import importlib\n_c = importlib.import_module("_common")\n',
        },
    )
    result = run_isolated(tmp_path / "bad.py")
    assert result["kind"] == "missing-module"
    assert result["module"] == "_common"


def test_catches_sys_path_hack(tmp_path: Path) -> None:
    write_case(
        tmp_path,
        {
            "helpers.py": "x = 1\n",
            "bad.py": (
                "import sys, os\n"
                "sys.path.insert(0, os.path.dirname(__file__))\n"
                "import helpers\n"
            ),
        },
    )
    result = run_isolated(tmp_path / "bad.py")
    assert result["kind"] == "missing-module"
    assert result["module"] == "helpers"


def test_catches_sibling_deferred_into_a_function(tmp_path: Path) -> None:
    # Never executes, since main() is not run — caught from the compiled code.
    write_case(
        tmp_path,
        {
            "_common.py": "def print_progress(p):\n    pass\n",
            "bad.py": (
                "import sys\n\n"
                "async def main():\n"
                "    from _common import print_progress\n"
                "    return 0\n"
            ),
        },
    )
    result = run_isolated(tmp_path / "bad.py")
    assert result["kind"] == "missing-module"
    assert result["module"] == "_common"


def test_allows_deferred_import_of_declared_package(tmp_path: Path) -> None:
    # vla.py defers `import numpy` into main(); that must stay legal.
    write_case(
        tmp_path,
        {
            "ok.py": (
                "import sys\n\nasync def main():\n    import numpy as np\n    return 0\n"
            )
        },
    )
    assert run_isolated(tmp_path / "ok.py") == {"ok": True}


def test_does_not_run_the_main_entry_point(tmp_path: Path) -> None:
    # Otherwise the check would need a worker and a model download.
    write_case(
        tmp_path,
        {
            "ok.py": (
                "import sys\n\n"
                'if __name__ == "__main__":\n'
                '    raise SystemExit("must not run")\n'
            )
        },
    )
    assert run_isolated(tmp_path / "ok.py") == {"ok": True}


def test_tolerates_module_level_use_of_a_stub(tmp_path: Path) -> None:
    write_case(
        tmp_path,
        {
            "ok.py": (
                "from tetherto.qvac_sdk.models import WHISPER_TINY\n"
                "MODELS = [WHISPER_TINY]\n"
                "NAME = str(WHISPER_TINY)\n"
            )
        },
    )
    assert run_isolated(tmp_path / "ok.py") == {"ok": True}


def test_reports_a_syntax_error(tmp_path: Path) -> None:
    write_case(tmp_path, {"bad.py": "def broken(:\n"})
    result = run_isolated(tmp_path / "bad.py")
    assert result["kind"] == "syntax-error"
    assert "line 1" in result["detail"]
