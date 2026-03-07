#!/usr/bin/env python3
"""Run dual Python-vs-TS eval windows and enforce parity thresholds."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import statistics
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import dotenv_values

DEFAULT_METRIC_THRESHOLDS = {
    "Delegation Compliance": 0.02,
    "Routing Accuracy": 0.03,
}


@dataclass
class EvalSummary:
    command: list[str]
    raw: dict[str, Any]
    score_delegation: float
    score_routing: float
    experiment_id: str | None
    experiment_url: str | None


def _load_env(env_file: Path) -> dict[str, str]:
    env = dict(os.environ)
    if env_file.exists():
        for key, value in dotenv_values(env_file).items():
            if value is not None:
                env[key] = value
    return env


def _extract_json_line(stdout: str) -> dict[str, Any]:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    for line in reversed(lines):
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise RuntimeError("Could not find JSON summary line in eval output")


def _extract_score(summary: dict[str, Any], metric_name: str) -> float:
    scores = summary.get("scores")
    if not isinstance(scores, dict):
        raise RuntimeError("Summary JSON did not include `scores`")
    metric = scores.get(metric_name)
    if not isinstance(metric, dict):
        raise RuntimeError(f"Summary JSON missing score metric `{metric_name}`")
    score = metric.get("score")
    if not isinstance(score, (int, float)):
        raise RuntimeError(f"Invalid score for metric `{metric_name}`: {score}")
    return float(score)


def _run_eval(command: list[str], env: dict[str, str], cwd: Path) -> EvalSummary:
    proc = subprocess.run(
        command,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "Eval command failed\n"
            f"command: {' '.join(shlex.quote(part) for part in command)}\n"
            f"exit_code: {proc.returncode}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )

    summary = _extract_json_line(proc.stdout)
    return EvalSummary(
        command=command,
        raw=summary,
        score_delegation=_extract_score(summary, "Delegation Compliance"),
        score_routing=_extract_score(summary, "Routing Accuracy"),
        experiment_id=(summary.get("experimentId") or summary.get("experiment_id")),
        experiment_url=(summary.get("experimentUrl") or summary.get("experiment_url")),
    )


def _default_python_eval_cli(repo_root: Path) -> list[str]:
    local_cli = repo_root / ".venv/bin/braintrust"
    if local_cli.exists():
        return [str(local_cli), "eval"]

    legacy_cli = Path("/Users/curtisjgalione/git/google-adk-supervisor/.venv/bin/braintrust")
    if legacy_cli.exists():
        return [str(legacy_cli), "eval"]

    if shutil.which("braintrust"):
        return ["braintrust", "eval"]

    raise RuntimeError(
        "Could not locate Python Braintrust CLI. Set --python-cli explicitly, e.g. `--python-cli braintrust`"
    )


def _default_ts_eval_cli() -> list[str]:
    if shutil.which("bt"):
        return ["bt", "eval"]

    if shutil.which("braintrust"):
        return ["braintrust", "eval"]

    raise RuntimeError(
        "Could not locate TypeScript eval CLI. Install `bt` or `braintrust`, or set --ts-cli explicitly."
    )


def parse_cli() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Dual-run parity gate for Python-vs-TS supervisor evals")
    parser.add_argument("--env-file", default=".env", help="Path to env file")
    parser.add_argument("--window-runs", type=int, default=2, help="Number of dual-run windows to execute")
    parser.add_argument("--eval-limit", type=int, default=8, help="Number of local dataset rows per run (excluding fixed guard case)")
    parser.add_argument(
        "--python-eval-file",
        default="evals/eval_supervisor.py",
        help="Python eval file",
    )
    parser.add_argument(
        "--ts-eval-file",
        default="evals/eval_supervisor.ts",
        help="TypeScript eval file",
    )
    parser.add_argument(
        "--python-cli",
        default="",
        help="Python Braintrust CLI command prefix (quoted string), e.g. '/path/to/braintrust eval'",
    )
    parser.add_argument(
        "--ts-cli",
        default="",
        help="TypeScript eval CLI command prefix (quoted string), e.g. 'bt eval'",
    )
    parser.add_argument(
        "--delegation-threshold",
        type=float,
        default=DEFAULT_METRIC_THRESHOLDS["Delegation Compliance"],
        help="Allowed max delta for Delegation Compliance: python_mean - ts_mean",
    )
    parser.add_argument(
        "--routing-threshold",
        type=float,
        default=DEFAULT_METRIC_THRESHOLDS["Routing Accuracy"],
        help="Allowed max delta for Routing Accuracy: python_mean - ts_mean",
    )
    parser.add_argument(
        "--project",
        default="vercel-ai-sdk-supervisor",
        help="Braintrust project name",
    )
    parser.add_argument(
        "--output-json",
        default="reports/parity_gate_latest.json",
        help="Path to write parity report JSON",
    )
    parser.add_argument(
        "--fail-on-regression",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Exit non-zero if thresholds are violated",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_cli()
    repo_root = Path(__file__).resolve().parents[1]
    env_file = (repo_root / args.env_file).resolve()
    env = _load_env(env_file)

    env["BRAINTRUST_PROJECT"] = args.project
    env["EVAL_LIMIT"] = str(max(1, args.eval_limit))
    env["TS_EVAL_LIMIT"] = str(max(1, args.eval_limit))
    env["PY_EVAL_LIMIT"] = str(max(1, args.eval_limit))
    env["USE_PUBLISHED_STEP_SCORER"] = "0"

    ts_cli = shlex.split(args.ts_cli) if args.ts_cli.strip() else _default_ts_eval_cli()
    py_cli = shlex.split(args.python_cli) if args.python_cli.strip() else _default_python_eval_cli(repo_root)

    ts_command = [*ts_cli, args.ts_eval_file, "--jsonl"]
    py_command = [*py_cli, args.python_eval_file, "--jsonl"]

    ts_runs: list[EvalSummary] = []
    py_runs: list[EvalSummary] = []

    for run_index in range(1, args.window_runs + 1):
        print(f"[run {run_index}] TS eval: {' '.join(ts_command)}")
        ts_summary = _run_eval(ts_command, env=env, cwd=repo_root)
        ts_runs.append(ts_summary)

        print(f"[run {run_index}] PY eval: {' '.join(py_command)}")
        py_summary = _run_eval(py_command, env=env, cwd=repo_root)
        py_runs.append(py_summary)

    def _mean(values: list[float]) -> float:
        return statistics.fmean(values) if values else 0.0

    ts_delegation_mean = _mean([item.score_delegation for item in ts_runs])
    ts_routing_mean = _mean([item.score_routing for item in ts_runs])
    py_delegation_mean = _mean([item.score_delegation for item in py_runs])
    py_routing_mean = _mean([item.score_routing for item in py_runs])

    delegation_delta = py_delegation_mean - ts_delegation_mean
    routing_delta = py_routing_mean - ts_routing_mean

    delegation_ok = delegation_delta <= args.delegation_threshold
    routing_ok = routing_delta <= args.routing_threshold
    passed = delegation_ok and routing_ok

    report = {
        "project": args.project,
        "window_runs": args.window_runs,
        "eval_limit": args.eval_limit,
        "thresholds": {
            "Delegation Compliance": args.delegation_threshold,
            "Routing Accuracy": args.routing_threshold,
        },
        "means": {
            "python": {
                "Delegation Compliance": py_delegation_mean,
                "Routing Accuracy": py_routing_mean,
            },
            "typescript": {
                "Delegation Compliance": ts_delegation_mean,
                "Routing Accuracy": ts_routing_mean,
            },
        },
        "deltas": {
            "Delegation Compliance": delegation_delta,
            "Routing Accuracy": routing_delta,
        },
        "status": {
            "Delegation Compliance": delegation_ok,
            "Routing Accuracy": routing_ok,
            "passed": passed,
        },
        "runs": {
            "typescript": [
                {
                    "experiment_id": run.experiment_id,
                    "experiment_url": run.experiment_url,
                    "scores": {
                        "Delegation Compliance": run.score_delegation,
                        "Routing Accuracy": run.score_routing,
                    },
                }
                for run in ts_runs
            ],
            "python": [
                {
                    "experiment_id": run.experiment_id,
                    "experiment_url": run.experiment_url,
                    "scores": {
                        "Delegation Compliance": run.score_delegation,
                        "Routing Accuracy": run.score_routing,
                    },
                }
                for run in py_runs
            ],
        },
    }

    output_path = (repo_root / args.output_json).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("\nParity report")
    print(f"  output: {output_path}")
    print(
        f"  Delegation Compliance delta (py-ts): {delegation_delta:.4f} "
        f"(threshold <= {args.delegation_threshold:.4f}) {'PASS' if delegation_ok else 'FAIL'}"
    )
    print(
        f"  Routing Accuracy delta (py-ts): {routing_delta:.4f} "
        f"(threshold <= {args.routing_threshold:.4f}) {'PASS' if routing_ok else 'FAIL'}"
    )
    print(f"  Overall: {'PASS' if passed else 'FAIL'}")

    if args.fail_on_regression and not passed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
