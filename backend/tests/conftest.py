"""Test harness: boots a *real* backend (uvicorn subprocess, LocalSandbox) and talks to it
over HTTP and WebSocket exactly like the browser does. Nothing is mocked: every test
asserts on what the sandboxed program actually printed."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
import websockets

BACKEND = Path(__file__).resolve().parent.parent
SECRET = "super-secret-signing-key-" + uuid.uuid4().hex


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, data_dir: Path, port: int, proc: subprocess.Popen):
        self.data_dir, self.port, self.proc = data_dir, port, proc
        self.http = f"http://127.0.0.1:{port}"
        self.ws = f"ws://127.0.0.1:{port}"

    def project_dir(self, pid: int) -> Path:
        return self.data_dir / "projects" / str(pid)


@pytest.fixture(scope="session")
def server():
    data = Path(tempfile.mkdtemp(prefix="cmp-test-"))
    data.chmod(0o711)  # sandbox uids must be able to traverse down to their project
    port = _free_port()
    env = {
        **os.environ,
        "COMPIELER_DATA_DIR": str(data),
        "COMPIELER_SANDBOX_BACKEND": os.environ.get("TEST_SANDBOX", "local"),
        "COMPIELER_SECRET_KEY": SECRET,
        "COMPIELER_RUN_WALL_SECONDS": "30",
        "COMPIELER_RUN_CPU_SECONDS": "10",
        "COMPIELER_MAX_OUTPUT_BYTES": "200000",
        "COMPIELER_MAX_RUNS_PER_USER": "3",
        "COMPIELER_RUNS_PER_MINUTE": "500",
        "COMPIELER_MEMORY_MB": "256",
        "COMPIELER_GUESTS_PER_HOUR": "100000",
        "PYTHONPATH": str(BACKEND),
    }
    ca = Path("/root/.ccr/ca-bundle.crt")  # TLS-intercepting proxy in some CI sandboxes
    if ca.exists():
        shutil.copy(ca, data / "ca.pem")
        (data / "ca.pem").chmod(0o644)
        env["COMPIELER_INSTALL_ENV"] = json.dumps({"NODE_EXTRA_CA_CERTS": str(data / "ca.pem")})
    log = open(data / "server.log", "wb")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=BACKEND, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    srv = Server(data, port, proc)
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            if httpx.get(f"{srv.http}/api/health", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.2)
    else:
        proc.kill()
        raise RuntimeError("backend did not start:\n" + (data / "server.log").read_text())
    yield srv
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
    shutil.rmtree(data, ignore_errors=True)


class Run:
    """Everything one job produced."""

    def __init__(self):
        self.events: list[dict] = []

    @property
    def stdout(self) -> str:
        return "".join(e["data"] for e in self.events if e["type"] == "output" and e["phase"] == "run" and e["stream"] == "stdout")

    @property
    def stderr(self) -> str:
        return "".join(e["data"] for e in self.events if e["type"] == "output" and e["phase"] == "run" and e["stream"] == "stderr")

    def log(self, phase: str) -> str:
        return "".join(e["data"] for e in self.events if e["type"] == "output" and e["phase"] == phase)

    @property
    def system(self) -> str:
        return self.log("system")

    @property
    def exit(self) -> dict:
        exits = [e for e in self.events if e["type"] == "exit"]
        assert len(exits) == 1, f"expected exactly one exit event, got {exits}"
        return exits[0]

    @property
    def problems(self) -> list[dict]:
        out: list[dict] = []
        for e in self.events:
            if e["type"] == "problems":
                out = e["items"]
        return out

    @property
    def all_text(self) -> str:
        return "".join(e.get("data", "") for e in self.events if e["type"] == "output")


class User:
    def __init__(self, server: Server, token: str, data: dict):
        self.server, self.token, self.data = server, token, data
        self.id = data["id"]
        self.http = httpx.Client(base_url=server.http + "/api", headers={"Authorization": f"Bearer {token}"}, timeout=60)

    def create_project(self, language: str, files: dict[str, str] | None = None, *, name="test", template=False, settings=None) -> int:
        r = self.http.post("/projects", json={"name": name, "language": language, "template": template})
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        for path, content in (files or {}).items():
            r = self.http.put(f"/projects/{pid}/file", json={"path": path, "content": content})
            assert r.status_code == 204, r.text
        if settings:
            r = self.http.patch(f"/projects/{pid}", json={"settings": settings})
            assert r.status_code == 200, r.text
        return pid

    async def session(self, pid: int):
        ws = await websockets.connect(f"{self.server.ws}/api/ws/projects/{pid}", max_size=None)
        await ws.send(json.dumps({"type": "auth", "token": self.token}))
        ready = json.loads(await asyncio.wait_for(ws.recv(), 10))
        assert ready["type"] == "ready", ready
        return ws

    async def execute(self, pid: int, message: dict, *, script=None, timeout=90) -> Run:
        """Send one job and collect events until its exit. ``script`` is a list of
        (wait_for_substring, send_message) pairs executed interactively."""
        run = Run()
        ws = await self.session(pid)
        try:
            await ws.send(json.dumps(message))
            steps = list(script or [])
            seen = ""
            async with asyncio.timeout(timeout):
                while True:
                    ev = json.loads(await ws.recv())
                    run.events.append(ev)
                    if ev["type"] == "output":
                        seen += ev["data"]
                    while steps and steps[0][0] in seen:
                        _, out = steps.pop(0)
                        seen = ""
                        await ws.send(json.dumps(out))
                    if ev["type"] == "exit":
                        break
                # make sure there is no duplicate exit event
                try:
                    extra = await asyncio.wait_for(ws.recv(), 0.3)
                    run.events.append(json.loads(extra))
                except (asyncio.TimeoutError, websockets.ConnectionClosed):
                    pass
        finally:
            await ws.close()
        assert not steps, f"interaction never reached: {steps[0][0]!r}; output was {run.all_text!r}"
        return run

    async def run(self, pid: int, **cfg) -> Run:
        return await self.execute(pid, {"type": "run", **cfg})

    async def shell(self, pid: int, command: str, **kw) -> Run:
        return await self.execute(pid, {"type": "shell", "command": command}, **kw)


@pytest.fixture
def new_user(server):
    def make() -> User:
        r = httpx.post(f"{server.http}/api/auth/guest", timeout=10)
        assert r.status_code == 200, r.text
        j = r.json()
        return User(server, j["token"], j["user"])

    return make


@pytest.fixture
def user(new_user) -> User:
    return new_user()


def live_processes_with(marker: str) -> list[int]:
    import psutil

    found = []
    for p in psutil.process_iter(["cmdline"]):
        try:
            if any(marker in part for part in (p.info["cmdline"] or [])) and p.pid != os.getpid():
                found.append(p.pid)
        except psutil.Error:
            pass
    return found


needs_root = pytest.mark.skipif(os.geteuid() != 0, reason="per-project uid isolation needs root")
