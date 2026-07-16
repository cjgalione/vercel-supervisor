"""Modal deployment wrapper for Braintrust TypeScript remote eval dev server."""

from __future__ import annotations

import asyncio
import os
import subprocess
from collections import deque

import modal
from fastapi import FastAPI, Request, Response

DEVSERVER_PORT = int(os.environ.get("BRAINTRUST_DEVSERVER_PORT", "8300"))
UPSTREAM_BASE = f"http://127.0.0.1:{DEVSERVER_PORT}"


def _modal_min_containers() -> int:
    value = os.environ.get("MODAL_MIN_CONTAINERS", "0")
    try:
        count = int(value)
    except ValueError as exc:
        raise RuntimeError("MODAL_MIN_CONTAINERS must be a non-negative integer") from exc
    if count < 0:
        raise RuntimeError("MODAL_MIN_CONTAINERS must be a non-negative integer")
    return count

modal_image = (
    modal.Image.debian_slim()
    .apt_install("curl", "git", "ca-certificates")
    .pip_install("modal", "fastapi[standard]", "httpx")
    .add_local_dir("src-ts", remote_path="/root/src-ts", copy=True)
    .add_local_dir("evals", remote_path="/root/evals", copy=True)
    .add_local_dir("scripts", remote_path="/root/scripts", copy=True)
    .add_local_file("dataset.jsonl", "/root/dataset.jsonl", copy=True)
    .add_local_file("package.json", "/root/package.json", copy=True)
    .add_local_file("package-lock.json", "/root/package-lock.json", copy=True)
    .add_local_file("tsconfig.json", "/root/tsconfig.json", copy=True)
    .run_commands(
        "cd /tmp && curl -fsSL https://github.com/braintrustdata/bt/releases/latest/download/bt-x86_64-unknown-linux-gnu.tar.gz -o bt.tar.gz && tar -xzf bt.tar.gz && install bt-x86_64-unknown-linux-gnu/bt /usr/local/bin/bt"
    )
    .run_commands("curl -fsSL https://deb.nodesource.com/setup_20.x | bash -")
    .apt_install("nodejs")
    .run_commands("cd /root && npm ci")
)

app = modal.App(
    os.environ.get(
        "MODAL_APP_NAME",
        "curtis-vercel-ai-supervisor-eval-server",
    ),
    image=modal_image,
)

_secrets = [modal.Secret.from_dotenv()]


@app.function(
    secrets=_secrets,
    min_containers=_modal_min_containers(),
    timeout=3600,
)
@modal.concurrent(max_inputs=10)
@modal.asgi_app()
def braintrust_eval_server() -> FastAPI:
    import httpx

    eval_app = FastAPI(title="Braintrust TS Eval Proxy")

    state: dict[str, object] = {"proc": None, "tail": deque(maxlen=120)}

    def _log_reader(stream, tail: deque[str], label: str) -> None:
        for line in iter(stream.readline, ""):
            entry = f"[{label}] {line.rstrip()}"
            tail.append(entry)
            print(entry, flush=True)

    async def _start_devserver_if_needed() -> None:
        proc = state.get("proc")
        if proc is not None and proc.poll() is None:
            return

        env = os.environ.copy()
        env.setdefault("BRAINTRUST_DEVSERVER_PORT", str(DEVSERVER_PORT))
        env.setdefault("BRAINTRUST_DEVSERVER_HOST", "0.0.0.0")

        tail = state["tail"]
        assert isinstance(tail, deque)

        proc = subprocess.Popen(
            ["npm", "run", "eval:dev"],
            cwd="/root",
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        state["proc"] = proc
        asyncio.create_task(asyncio.to_thread(_log_reader, proc.stdout, tail, "eval:stdout"))
        asyncio.create_task(asyncio.to_thread(_log_reader, proc.stderr, tail, "eval:stderr"))

        deadline = asyncio.get_event_loop().time() + 45
        while True:
            proc = state.get("proc")
            if not isinstance(proc, subprocess.Popen):
                raise RuntimeError("Failed to start Braintrust TS devserver")
            if proc.poll() is not None:
                recent = "\n".join(list(tail)[-20:])
                raise RuntimeError(
                    f"Failed to start Braintrust TS devserver (exit={proc.returncode}). Recent logs:\n{recent}"
                )
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    await client.get(f"{UPSTREAM_BASE}/")
                    return
            except Exception:
                if asyncio.get_event_loop().time() > deadline:
                    raise RuntimeError("Timed out waiting for Braintrust TS devserver")
                await asyncio.sleep(0.5)

    @eval_app.on_event("startup")
    async def startup_event() -> None:
        await _start_devserver_if_needed()

    @eval_app.on_event("shutdown")
    async def shutdown_event() -> None:
        proc = state.get("proc")
        if proc is not None and proc.poll() is None:
            proc.terminate()

    @eval_app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    async def proxy(path: str, request: Request) -> Response:
        await _start_devserver_if_needed()

        query = request.url.query
        upstream_url = f"{UPSTREAM_BASE}/{path}"
        if query:
            upstream_url = f"{upstream_url}?{query}"

        body = await request.body()
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"host", "content-length", "connection", "transfer-encoding"}
        }

        async with httpx.AsyncClient(timeout=300.0) as client:
            upstream_response = await client.request(
                method=request.method,
                url=upstream_url,
                content=body,
                headers=headers,
            )

        response_headers = {
            key: value
            for key, value in upstream_response.headers.items()
            if key.lower() not in {"content-encoding", "transfer-encoding", "connection"}
        }

        return Response(
            content=upstream_response.content,
            status_code=upstream_response.status_code,
            headers=response_headers,
            media_type=upstream_response.headers.get("content-type"),
        )

    return eval_app


@app.local_entrypoint()
def test() -> None:
    print("Testing Braintrust TypeScript eval server deployment...")
    print("Deploy with: modal deploy src/eval_server.py")
