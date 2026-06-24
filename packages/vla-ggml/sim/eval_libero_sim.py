#!/usr/bin/env python3
"""LIBERO closed-loop eval driver supporting both backends.

Backends:
    qvac    — route inference through the running vla-server (QVAC GGUF
              addon over HTTP). Requires vla-server up on localhost:8765
              with QVAC_VLA_MODEL pointing at the GGUF you want to score.
    pytorch — use the original PyTorch SmolVLAPolicy from lerobot
              directly. No server needed; recommend --policy.device=cuda
              if a GPU is available.

The two backends share the same lerobot eval harness, so success rates
are directly comparable when run with identical --eval.n_episodes,
--env.task, and seeds.

Usage (qvac):
    # 1) start the server in another shell:
    cd ~/vla-server && QVAC_VLA_MODEL=/path/to/x.gguf bare server.js
    # 2) run the eval:
    python eval_libero_sim.py --backend qvac \\
        --policy.path=HuggingFaceVLA/smolvla_libero \\
        --env.type=libero --env.task=libero_spatial \\
        --eval.n_episodes=3 --eval.batch_size=1 \\
        --policy.device=cpu \\
        --output_dir=/tmp/eval_qvac

Usage (pytorch):
    python eval_libero_sim.py --backend pytorch \\
        --policy.path=HuggingFaceVLA/smolvla_libero \\
        --env.type=libero --env.task=libero_spatial \\
        --eval.n_episodes=3 --eval.batch_size=1 \\
        --policy.device=cuda \\
        --output_dir=/tmp/eval_pytorch
"""
import os
import sys

# --------------------------------------------------------------------------- #
# Parse --backend before lerobot / draccus sees argv.                         #
# --------------------------------------------------------------------------- #

def _extract_backend_flag(argv):
    """Pull --backend / --backend=X out of argv, return (backend, new_argv)."""
    backend = 'pytorch'
    out = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith('--backend='):
            backend = a.split('=', 1)[1]
        elif a == '--backend':
            if i + 1 >= len(argv):
                print('ERROR: --backend requires a value', file=sys.stderr)
                sys.exit(2)
            backend = argv[i + 1]
            i += 1
        else:
            out.append(a)
        i += 1
    return backend, out


backend, sys.argv = _extract_backend_flag(sys.argv)

if backend not in ('qvac', 'pytorch'):
    print(f"ERROR: --backend must be 'qvac' or 'pytorch', got {backend!r}",
          file=sys.stderr)
    sys.exit(2)

print(f"[eval_libero_sim] backend = {backend}")

# --------------------------------------------------------------------------- #
# Make sibling files (qvac_http_policy.py, smolvla_http.py) importable        #
# regardless of cwd. They ship in this folder.                                #
# --------------------------------------------------------------------------- #
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

from lerobot.utils.utils import init_logging
from lerobot.utils.import_utils import register_third_party_plugins

# --------------------------------------------------------------------------- #
# Optional: monkey-patch make_policy to wrap the PyTorch policy with the      #
# QVAC HTTP backend. Only when backend == 'qvac'.                             #
# --------------------------------------------------------------------------- #
if backend == 'qvac':
    import lerobot.policies as policies_module
    import lerobot.scripts.lerobot_eval as eval_module
    from qvac_http_policy import SmolVLAQvacHTTPPolicy

    _original_make_policy = policies_module.make_policy

    def make_qvac_policy(cfg, **kwargs):
        pytorch_policy = _original_make_policy(cfg, **kwargs)
        print('[eval_libero_sim] wrapping policy with QVAC HTTP backend')
        return SmolVLAQvacHTTPPolicy.from_pytorch(pytorch_policy)

    policies_module.make_policy = make_qvac_policy
    eval_module.make_policy = make_qvac_policy

# Import last so eval_main picks up the patched make_policy if present.
from lerobot.scripts.lerobot_eval import eval_main


def main():
    init_logging()
    register_third_party_plugins()
    eval_main()


if __name__ == '__main__':
    main()
