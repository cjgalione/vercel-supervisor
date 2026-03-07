"""Backward-compatible local runner wrapper.

The runtime has moved to TypeScript. This module keeps the historical Python
entrypoint stable by delegating to `npm run run:local`.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    subprocess.run(["npm", "run", "run:local"], cwd=str(root), check=True)


if __name__ == "__main__":
    main()
