from __future__ import annotations

import logging

from ..config import Settings
from .base import Sandbox
from .docker import DockerSandbox
from .local import LocalSandbox

log = logging.getLogger("compieler.sandbox")


async def create_sandbox(settings: Settings) -> Sandbox:
    """Pick and probe the sandbox backend according to settings."""
    choice = settings.sandbox_backend
    if choice in ("auto", "docker"):
        sbx = DockerSandbox(settings)
        try:
            await sbx.probe()
            log.info("Using DockerSandbox (%s)", settings.runner_image)
            return sbx
        except Exception as e:  # noqa: BLE001
            if choice == "docker":
                raise
            log.warning("Docker sandbox unavailable (%s) - falling back to LocalSandbox", e)
    local = LocalSandbox(settings)
    info = await local.probe()
    if settings.env == "prod" and info["isolation"] == "L0":
        raise RuntimeError("Refusing to start in prod with an L0 local sandbox; use Docker")
    log.info("Using LocalSandbox: %s", info)
    return local
