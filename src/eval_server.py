"""Modal deployment wrapper for Braintrust TypeScript remote eval dev server."""

from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path

import modal
from fastapi import FastAPI, Request, Response
import httpx

DEVSERVER_PORT = int(os.environ.get("BRAINTRUST_DEVSERVER_PORT", "8300"))
UPSTREAM_BASE = f"http://127.0.0.1:{DEVSERVER_PORT}"

modal_image = (
    modal.Image.debian_slim()
    .apt_install("curl", "git", "nodejs", "npm")
    .pip_install_from_requirements("requirements.txt")
    .add_local_dir("src-ts", remote_path="/root/src-ts", copy=True)
    .add_local_dir("evals", remote_path="/root/evals", copy=True)
    .add_local_dir("scripts", remote_path="/root/scripts", copy=True)
    .add_local_file("dataset.jsonl", "/root/dataset.jsonl", copy=True)
    .add_local_file("package.json", "/root/package.json", copy=True)
    .add_local_file("package-lock.json", "/root/package-lock.json", copy=True)
    .add_local_file("tsconfig.json", "/root/tsconfig.json", copy=True)
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
    min_containers=1,
    timeout=3600,
)
@modal.concurrent(max_inputs=10)
@modal.asgi_app()
def braintrust_eval_server() -> FastAPI:
    eval_app = FastAPI(title="Braintrust TS Eval Proxy")

    state: dict[str, subprocess.Popen[str] | None] = {"proc": None}

    async def _start_devserver_if_needed() -> None:
        proc = state.get("proc")
        if proc is not None and proc.poll() is None:
            return

        env = os.environ.copy()
        env.setdefault("BRAINTRUST_DEVSERVER_PORT", str(DEVSERVER_PORT))

        state["proc"] = subprocess.Popen(
            ["npm", "run", "eval:dev"],
            cwd="/root",
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )

        deadline = asyncio.get_event_loop().time() + 45
        while True:
            if state["proc"] is None or state["proc"].poll() is not None:
                raise RuntimeError("Failed to start Braintrust TS devserver")
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
