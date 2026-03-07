#!/usr/bin/env python3
"""Backward-compatible wrapper for TypeScript batch query runner."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        ["npm", "run", "run:queries", "--", *sys.argv[1:]],
        cwd=str(root),
        check=True,
    )


if __name__ == "__main__":
    main()
