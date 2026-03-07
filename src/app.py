"""Backward-compatible alias for Modal deployment entrypoint."""

from src.eval_server import app, braintrust_eval_server

__all__ = ["app", "braintrust_eval_server"]
