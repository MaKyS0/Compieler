"""Application settings, loaded from COMPIELER_* environment variables."""
from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="COMPIELER_", env_file=".env", extra="ignore")

    env: Literal["dev", "prod"] = "dev"
    secret_key: str = ""
    data_dir: Path = Path("./data")
    database_url: str = ""
    cors_origins: list[str] = Field(default_factory=list)
    static_dir: Path | None = None  # built frontend to serve (optional)
    token_ttl_days: int = 30
    guest_ttl_days: int = 30

    # --- sandbox selection -------------------------------------------------
    sandbox_backend: Literal["auto", "docker", "local"] = "auto"
    runner_image: str = "compieler-runner:latest"
    docker_network: str = "compieler-sandbox"
    docker_subnet: str = "172.30.0.0/16"  # sandbox bridge; docker/egress-firewall.sh filters it
    # Either a named docker volume holding DATA_DIR (volume-subpath mounts) ...
    docker_data_volume: str = ""
    # ... or the host path that DATA_DIR is bind-mounted from.
    docker_host_data_dir: str = ""
    docker_uid: int = 10001
    # Extra environment for phases that have network access (pip/npm): mirrors, proxies, CA bundles.
    # e.g. COMPIELER_INSTALL_ENV='{"PIP_INDEX_URL":"https://mirror/simple","NODE_EXTRA_CA_CERTS":"/certs/ca.pem"}'
    install_env: dict[str, str] = Field(default_factory=dict)
    shared_pkg_cache: bool = True  # docker only; see README "Threat model"
    # Local sandbox: every project runs under uid = base + project_id (needs root).
    sandbox_uid_base: int = 200_000

    # --- run limits ---------------------------------------------------------
    run_wall_seconds: float = 60.0      # hard ceiling a client may request
    run_cpu_seconds: float = 15.0
    compile_wall_seconds: float = 90.0
    install_wall_seconds: float = 300.0
    memory_mb: int = 512
    max_processes: int = 128
    max_output_bytes: int = 1_000_000
    max_file_write_mb: int = 64         # RLIMIT_FSIZE inside the sandbox
    max_open_files: int = 512

    # --- quotas / abuse protection -----------------------------------------
    max_concurrent_runs: int = 8
    max_runs_per_user: int = 2
    runs_per_minute: int = 30
    max_projects_per_user: int = 50
    max_project_bytes: int = 100 * 1024 * 1024
    max_edit_file_bytes: int = 2 * 1024 * 1024
    max_upload_bytes: int = 25 * 1024 * 1024
    max_files_per_project: int = 2000
    allow_runtime_network: bool = False  # lets a run opt in to outbound network
    allow_registration: bool = True
    guests_per_hour: int = 30          # per client IP
    auth_attempts_per_5min: int = 10   # login/register per client IP

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def private_dir(self) -> Path:
        """Backend-only files (database, signing key): 0700, unreadable by sandbox uids."""
        return self.data_dir / "private"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{(self.private_dir / 'compieler.db').resolve()}"


def _load_or_create_secret(data_dir: Path) -> str:
    """In dev, persist a random secret next to the data so tokens survive restarts."""
    path = data_dir / "private" / ".secret_key"
    if path.exists():
        return path.read_text().strip()
    value = secrets.token_urlsafe(48)
    path.write_text(value)
    path.chmod(0o600)
    return value


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir = s.data_dir.resolve()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    # Traverse-only for everyone else: sandbox uids must not list/read sibling data.
    try:
        s.data_dir.chmod(0o711)
    except OSError:
        pass
    s.projects_dir.mkdir(exist_ok=True)
    s.projects_dir.chmod(0o711)
    s.tmp_dir.mkdir(exist_ok=True)
    s.tmp_dir.chmod(0o711)
    s.private_dir.mkdir(exist_ok=True)
    s.private_dir.chmod(0o700)
    if not s.secret_key:
        if s.env == "prod":
            raise RuntimeError("COMPIELER_SECRET_KEY must be set when COMPIELER_ENV=prod")
        s.secret_key = _load_or_create_secret(s.data_dir)
    return s
