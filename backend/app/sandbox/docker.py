"""DockerSandbox: one throw-away, locked-down container per command.

Hardening applied to every container: no network (unless the phase needs it), read-only
root filesystem, all capabilities dropped, no-new-privileges, pids/memory/cpu/ulimit
caps, unprivileged uid, only the project directory mounted. The ``docker`` CLI is used
instead of the SDK so stdin/stdout/stderr stay plain pipes.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import shutil
from pathlib import Path

from ..config import Settings
from .base import ExecRequest, Sandbox, SpawnedProcess

log = logging.getLogger("compieler.sandbox.docker")


async def _docker(*args: str, timeout: float = 20) -> tuple[int, str]:
    p = await asyncio.create_subprocess_exec(
        "docker", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except asyncio.TimeoutError:
        p.kill()
        return 124, "timeout"
    return p.returncode or 0, out.decode(errors="replace").strip()


class DockerSandbox(Sandbox):
    name = "docker"
    signal_exit_codes = True

    def __init__(self, settings: Settings):
        self.s = settings

    def workdir(self, project_id: int, project_dir: Path) -> str:
        return "/work"

    def project_uid(self, project_id: int) -> int | None:
        return self.s.docker_uid

    def cache_path(self, project_id: int, project_dir: Path) -> str:
        return "/cache" if self.s.shared_pkg_cache else "/work/.compieler/cache"

    def default_path(self) -> str:
        return "/usr/local/bin:/usr/bin:/bin"

    def describe(self) -> dict:
        return {"backend": self.name, "isolation": "container", "image": self.s.runner_image}

    async def probe(self) -> dict:
        if not shutil.which("docker"):
            raise RuntimeError("docker CLI not found")
        code, out = await _docker("info", "--format", "{{.ServerVersion}}")
        if code != 0:
            raise RuntimeError(f"docker daemon unavailable: {out}")
        code, out = await _docker("image", "inspect", self.s.runner_image, "--format", "{{.Id}}")
        if code != 0:
            raise RuntimeError(
                f"runner image {self.s.runner_image!r} not found - build it with "
                "`docker build -f docker/runner.Dockerfile -t compieler-runner .`"
            )
        # make sure the sandbox network exists (idempotent)
        code, _ = await _docker("network", "inspect", self.s.docker_network)
        if code != 0:
            code, out = await _docker(
                "network", "create", "--driver", "bridge", "--subnet", self.s.docker_subnet,
                "-o", "com.docker.network.bridge.enable_icc=false", self.s.docker_network,
            )
            if code != 0:
                raise RuntimeError(f"cannot create sandbox network: {out}")
        # shared package cache, writable by the sandbox uid
        cache = self.s.data_dir / "cache"
        cache.mkdir(exist_ok=True)
        try:
            import os

            os.chown(cache, self.s.docker_uid, self.s.docker_uid)
        except (PermissionError, OSError):
            cache.chmod(0o777)
        return self.describe()

    def _mounts(self, req: ExecRequest) -> list[str]:
        sub = f"projects/{req.project_id}"
        if self.s.docker_data_volume:
            return ["--mount", f"type=volume,src={self.s.docker_data_volume},dst=/work,volume-subpath={sub}"]
        host = self.s.docker_host_data_dir or str(self.s.data_dir)
        return ["--mount", f"type=bind,src={host}/{sub},dst=/work"]

    async def spawn(self, req: ExecRequest) -> SpawnedProcess:
        lim = req.limits
        name = f"cmp-{req.project_id}-{secrets.token_hex(6)}"
        args = [
            "run", "--name", name, "-i", "--init",
            "--label", "compieler=1",
            "--network", "none" if req.network == "none" else self.s.docker_network,
            "--read-only",
            "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=128m",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", str(lim.nproc),
            "--memory", f"{lim.memory_mb}m", "--memory-swap", f"{lim.memory_mb}m",
            "--cpus", "1",
            "--ulimit", f"cpu={max(1, int(lim.cpu_s))}:{int(lim.cpu_s) + 2}",
            "--ulimit", f"fsize={lim.fsize_mb * 1024 * 1024}",
            "--ulimit", f"nofile={lim.nofile}:{lim.nofile}",
            "--ulimit", "core=0",
            "--user", f"{self.s.docker_uid}:{self.s.docker_uid}",
            "-w", "/work",
            "-e", "HOME=/tmp",
            *self._mounts(req),
        ]
        if self.s.shared_pkg_cache and req.network != "none":
            sub = "cache"
            if self.s.docker_data_volume:
                args += ["--mount", f"type=volume,src={self.s.docker_data_volume},dst=/cache,volume-subpath={sub}"]
            else:
                host = self.s.docker_host_data_dir or str(self.s.data_dir)
                args += ["--mount", f"type=bind,src={host}/{sub},dst=/cache"]
        for k, v in req.env.items():
            args += ["-e", f"{k}={v}"]
        args += [self.s.runner_image, *req.argv]

        proc = await asyncio.create_subprocess_exec(
            "docker", *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=1 << 20,
        )

        async def kill() -> None:
            await _docker("kill", name, timeout=10)
            try:
                proc.kill()
            except ProcessLookupError:
                pass

        async def oom() -> bool:
            code, out = await _docker("inspect", "-f", "{{.State.OOMKilled}}", name)
            return code == 0 and out == "true"

        async def cleanup() -> None:
            await _docker("rm", "-f", name, timeout=15)

        return SpawnedProcess(proc=proc, cleanup=cleanup, kill=kill, was_oom_killed=oom)
