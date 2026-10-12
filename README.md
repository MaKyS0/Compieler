# Compieler — online IDE for Python, C++ and JavaScript

A browser IDE with a real backend: your code is executed on the server by real **CPython**, **GCC (g++)** and **Node.js**, inside a sandbox. Nothing is simulated — output, errors, exit codes, `stdin`, `pip`/`npm` installs and file access are all genuine.

* **Editor** – Monaco (VS Code's editor) with syntax highlighting, completion, find/replace, formatting, light & dark themes, resizable panels, and a phone layout with a programming-symbol keyboard.
* **Languages** – Python 3 (full standard library, per-project virtualenv, `requirements.txt`, pip), C++17/20/23 (multi-file, diagnostics → *Problems*), Node.js (modern JS, CommonJS/ESM, `package.json`, npm).
* **I/O** – real `stdin`/`stdout`/`stderr` over WebSocket: pre-filled input (*Input* tab, with EOF) or interactive typing in the *Terminal* while the program runs; *Stop* kills the process tree.
* **Projects** – multi-file projects with folders, autosave, restore after reload, ZIP import/export, recent-project list, temporary guest sessions that can be upgraded to real accounts.
* **Safety** – every run is untrusted: unprivileged user, CPU / wall-clock / memory / process / file-size / output limits, no network by default, per-project isolation, authorization enforced on the backend.

> **Honest status:** the backend suite (104 tests) passes on both the local and the Docker sandbox, the API passes on PostgreSQL, and 19 browser tests pass — see [What was verified](#what-was-verified-and-what-was-not) for exactly what was run and the few parts (full compose stack, egress firewall) that were not.

---

## Offline app for Android (APK) — no server needed

The same UI also ships as a **standalone build** where nothing runs on a server: projects are stored on the device (IndexedDB) and the three languages run in WebAssembly engines inside the app's WebView.

| Language | Engine on the device | Notes |
|---|---|---|
| Python 3.14 | **CPython compiled to WebAssembly (Pyodide 314)** | full standard library incl. `sqlite3`, `hashlib`, `asyncio.run`; `numpy` bundled; `pandas`, `matplotlib`, `scipy`, `sympy`, `pillow`, … load from the Pyodide CDN when online; `pip install` (pure-Python wheels) via micropip |
| C++ | **real clang + lld (LLVM 22, [YoWASP](https://yowasp.org) build) compiled to WebAssembly**, wasi-libc + libc++ | C++11–**C++23** (`<print>`, `std::format`, ranges), STL, multi-file projects, file streams, diagnostics → *Problems*; **no exceptions, no threads**. The compiler is ~100 MB of WebAssembly, so the first compile after launch takes a while |
| JavaScript | V8 of the WebView with a **Node.js-compatible environment** | `fs` (project files), `path`, `util`, `events`, `readline`, `crypto`, `os`, `stream`, `url`, `assert`, timers, CommonJS + ES modules; npm packages are fetched from a CDN when required (online) |

Interactive input works (Terminal tab, `Ctrl+D` = EOF). In a browser the engines block on a `SharedArrayBuffer` (needs cross-origin isolation). The Android WebView does not provide that, so the APK uses a native channel instead: the engine does a synchronous XHR to `/__stdin/<n>`, which the app answers from `shouldInterceptRequest` as soon as you type a line (`StdinChannel.java`).

**Differences from the server version (be aware):** this is *not* the server sandbox — no `subprocess`/`os.system`, no raw sockets or servers (use `fetch`), no threads/multiprocessing, no C++ exceptions, `node_modules`/`npm install` do not exist (CDN fetch instead), no Black/clang-format/prettier formatting, no accounts (data stays on the device — export ZIP to back up), one program at a time, 60 s time limit. The Terminal is a small built-in shell (`help`).

### Get the APK

* **Releases:** after the *Build Android APK* workflow ran (Actions tab → *Run workflow*, or push a `v*` tag) the file `Compieler.apk` is attached to the GitHub Release; open the release page on the phone and download it. Android asks to allow installs from your browser/file manager.
* **Build yourself:** `ANDROID_HOME=… ./scripts/build-apk.sh` → `dist/Compieler.apk` (needs Node ≥ 20, JDK 17+, Android SDK 34).
* **No Android?** `cd frontend && npm run dev:standalone` (or host `dist-standalone/` on any static server — the app registers a tiny service worker to obtain the required isolation headers) runs the same offline app in a desktop/mobile browser.

The APK is signed with a fixed key committed in `android/app/compieler.keystore` (so new builds install as updates; it protects nothing else). First launch loads the Python/C++ engines (a few seconds); later runs are fast.

## Contents

1. [Architecture](#architecture) · 2. [Requirements](#requirements) · 3. [Quick start (development)](#quick-start-development) · 4. [Production with Docker Compose](#production-with-docker-compose) · 5. [Configuration](#configuration) · 6. [Testing](#testing) · 7. [Security model](#security-model) · 8. [How execution works](#how-execution-works) · 9. [API](#api) · 10. [Project layout](#project-layout) · 11. [Limitations](#limitations) · 12. [What was verified](#what-was-verified-and-what-was-not)

## Architecture

```
 browser (React + Monaco + xterm.js)
    │  HTTPS (REST: projects/files/auth)        WebSocket (run / stdin / stop / output)
    ▼
 nginx ──────────────► FastAPI backend ──► SQLAlchemy ──► PostgreSQL (SQLite in dev)
                          │   │
                          │   └─ ProjectFS: symlink-safe file operations on  data/projects/<id>/
                          ▼
                       Sandbox  (pluggable)
                        ├─ DockerSandbox : one locked-down container per command   (production)
                        └─ LocalSandbox  : rlimits + PID/net namespaces + per-project uid   (dev / CI)
```

* Project **files live on disk** (`data/projects/<id>/`) — the same directory the sandbox sees — the database only stores metadata (users, project names, settings).
* A **job** (`runner/session.py`) is the pipeline *install → compile → run*. Each phase is a separate sandboxed command with its own limits; output is streamed to the client, which decides which tab it belongs in.
* Redis is **not** required: the run registry, rate limiter and concurrency counters are in process memory, so the backend runs as **one worker** (scale vertically or shard by user at the load balancer).

## Requirements

| Component | Needed for | Notes |
|---|---|---|
| Python ≥ 3.11 | backend | tested on 3.13 |
| Node.js ≥ 20 | frontend build, JS runtime, prettier | tested on 22 |
| g++ ≥ 11 | C++ runtime | `-std=c++23` needs GCC ≥ 11 (full `__cplusplus` value from GCC 14) |
| `black`, `clang-format`, `prettier` | *Format* button | optional; the button is disabled for languages whose formatter is missing |
| Docker ≥ 26 | production sandbox | `volume-subpath` mounts need Engine 26+ |
| `unshare` (util-linux), root | LocalSandbox isolation level L1 | without it LocalSandbox falls back to L0 (see [Security model](#security-model)) |
| PostgreSQL ≥ 13 | production DB | SQLite is used when `COMPIELER_DATABASE_URL` is unset |

## Quick start (development)

```bash
# 1. backend
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
export COMPIELER_DATA_DIR=./data      # created automatically
uvicorn app.main:app --reload --port 8000

# 2. frontend (separate terminal) – dev server proxies /api and WebSocket to :8000
cd frontend
npm install
npm run dev                            # http://localhost:5173
```

Or build once and let the backend serve the UI on a single port:

```bash
cd frontend && npm ci && npm run build
cd ../backend && COMPIELER_STATIC_DIR=../frontend/dist uvicorn app.main:app --port 8000   # http://localhost:8000
```

On start-up the backend probes for Docker; with no Docker it uses the **LocalSandbox** and logs the isolation level it achieved (`L1` when run as root with `unshare` available). `GET /api/health` and the status bar show the active sandbox.

> Run the backend as **root** (e.g. in a throw-away VM/container) if you want per-project uids and namespaces in local mode. As a normal user the local sandbox still applies resource limits, but all projects share your uid and user code can read what you can read — use it only for development.

## Termux (Android)

Works for personal use (no root ⇒ no per-project uid / namespaces: see [Security model](#security-model)).

```bash
pkg update -y && pkg upgrade -y
pkg install -y git python nodejs clang binutils libffi openssl
pkg install -y python-pydantic python-psutil 2>/dev/null || true   # prebuilt where available (avoids Rust builds)

git clone -b claude/elegant-newton-dfnobl https://github.com/MaKyS0/Compieler && cd Compieler
cd frontend && npm ci && npx vite build && cd ..          # `vite build` directly: TypeScript's native tsc does not run on Android

cd backend
python -m venv --system-site-packages .venv && . .venv/bin/activate
pip install -r requirements.txt                          # psutil is skipped on Android; the backend reads /proc instead
export COMPIELER_DATA_DIR=$HOME/compieler-data COMPIELER_STATIC_DIR=$HOME/Compieler/frontend/dist COMPIELER_SANDBOX_BACKEND=local
uvicorn app.main:app --host 127.0.0.1 --port 8000        # open http://127.0.0.1:8000
```

`npm run build` = `vite build`; use `npm run build:check` (or `npm run typecheck`) for the type-check, which needs a desktop OS.

## Production with Docker Compose

```bash
cp .env.example .env                                   # set COMPIELER_SECRET_KEY and POSTGRES_PASSWORD
docker compose --profile build build runner-image      # sandbox image (python + g++ + node + build libs)
docker compose up -d --build
sudo ./docker/egress-firewall.sh                       # block internal ranges for sandbox containers
# open http://<host>:8080
```

* `nginx` terminates HTTP (put TLS in front or add certificates), rate-limits `/api/auth`, proxies the WebSocket with long timeouts and sets a strict CSP.
* The backend creates the `compieler-sandbox` bridge network (`172.30.0.0/16`) itself; `docker/egress-firewall.sh` installs `DOCKER-USER` rules so containers on it can reach the public Internet but not RFC1918/link-local/metadata addresses. Containers started with `--network none` (every normal run) need no rule.
* Pre-install heavy packages for everyone with `RUNNER_PRELOAD_PACKAGES="numpy pandas matplotlib scipy pillow"` in `.env` (rebuild the runner image). Project venvs use `--system-site-packages`, so these are visible without downloads.
* Back up the `compieler_data` (project files) and `pgdata` volumes.

## Configuration

All settings are environment variables prefixed `COMPIELER_` (or a `.env` file next to the backend).

| Variable | Default | Meaning |
|---|---|---|
| `ENV` | `dev` | `prod` requires `SECRET_KEY` and refuses an L0 local sandbox |
| `SECRET_KEY` | generated in dev | JWT signing key (**set in prod**) |
| `DATA_DIR` | `./data` | project files, DB (SQLite), temp dirs |
| `DATABASE_URL` | SQLite in `DATA_DIR/private` | e.g. `postgresql+asyncpg://user:pw@host/db` |
| `STATIC_DIR` | – | built frontend to serve |
| `SANDBOX_BACKEND` | `auto` | `docker`, `local`, or `auto` (Docker if reachable) |
| `RUNNER_IMAGE` | `compieler-runner:latest` | sandbox image |
| `DOCKER_DATA_VOLUME` / `DOCKER_HOST_DATA_DIR` | – | how containers mount project dirs (named volume with subpath, or host bind path) |
| `DOCKER_SUBNET` / `DOCKER_INSTALL_MOUNTS` | `172.30.0.0/16` / `[]` | sandbox bridge subnet (for the egress firewall); extra read-only mounts for network phases, e.g. a corporate CA `["/etc/ca.pem:/etc/ca.pem"]` |
| `RUN_WALL_SECONDS` / `RUN_CPU_SECONDS` | `60` / `15` | wall-clock and CPU ceilings for a run (clients may ask for less) |
| `COMPILE_WALL_SECONDS` / `INSTALL_WALL_SECONDS` | `90` / `300` | compile and pip/npm phases |
| `MEMORY_MB` / `MAX_PROCESSES` | `512` / `128` | per-run memory and process/thread cap |
| `MAX_OUTPUT_BYTES` | `1000000` | output cap per run (then the program is killed) |
| `MAX_FILE_WRITE_MB` | `64` | largest single file a program may write |
| `MAX_CONCURRENT_RUNS` / `MAX_RUNS_PER_USER` | `8` / `2` | global and per-user concurrency (extra runs queue up to 30 s) |
| `RUNS_PER_MINUTE` | `30` | run starts per user per minute |
| `MAX_PROJECT_BYTES`, `MAX_FILES_PER_PROJECT`, `MAX_PROJECTS_PER_USER`, `MAX_UPLOAD_BYTES` | 100 MB, 2000, 50, 25 MB | quotas |
| `ALLOW_RUNTIME_NETWORK` | `false` | let a run opt in to outbound network (see Security) |
| `ALLOW_REGISTRATION` | `true` | allow creating accounts |
| `INSTALL_ENV` | `{}` | JSON of extra env for network phases: `{"PIP_INDEX_URL":"…","NODE_EXTRA_CA_CERTS":"/certs/ca.pem"}` |
| `GUESTS_PER_HOUR`, `AUTH_ATTEMPTS_PER_5MIN` | `30`, `10` | per-IP throttles |
| `GUEST_TTL_DAYS` | `30` | unused guest accounts and their files are deleted |

## Testing

```bash
# backend: boots a real uvicorn server + LocalSandbox and talks to it over HTTP/WebSocket
cd backend && pip install -r requirements-dev.txt
pytest                              # everything (needs g++, node, and internet for the pip/npm tests)
pytest -m "not network"             # without the tests that install from PyPI / npm
sudo -E env "PATH=$PATH" pytest     # as root, to also exercise per-project uid isolation

# offline app: engines run in WebAssembly, no backend
cd frontend && npm ci && npm run build:standalone
cd ../e2e && npm ci && npx playwright test -c playwright.standalone.config.ts

# browser end-to-end (Chromium via Playwright) against the built frontend
cd frontend && npm ci && npm run build
cd ../e2e && npm ci && npx playwright test
```

The tests assert on **what the sandboxed program actually produced**, never on HTTP 200 alone. They cover: Python stdlib imports, `os`/`pathlib`/`subprocess`, files in the project dir, `input()` (prefilled and interactive), exceptions and syntax errors, multi-file projects, `pip install requests`; C++ compile/run, `cin/cout`, syntax errors → diagnostics, multi-file builds, C++17/20/23; Node `console.log`, `fs`, ESM/CJS, `npm install`; and security: secret isolation, tenant isolation (HTTP, WebSocket, and filesystem), path traversal, planted symlinks/FIFOs, zip-slip/zip bombs, timeouts, CPU/memory/output/file-size/process limits, killing of hung and detached processes, cleanup of temp dirs, concurrency limits.

## Security model

Every run is treated as hostile code. What is enforced, and where:

| Threat | Defence |
|---|---|
| Code reads backend secrets (`SECRET_KEY`, DB) | sandbox gets a **stripped environment**; DB and key live in `data/private` (0700, root); in Docker nothing but the project dir is mounted |
| Code reads/writes other users' projects | authorization checked on **every** route and the WebSocket (foreign project ⇒ 404 / close 4404); local sandbox: **one uid per project**, 0700 dirs; Docker: only the own project mounted |
| Path traversal / symlink tricks via the file API | `ProjectFS` walks paths with `O_NOFOLLOW` relative to directory fds, rejects `..`, absolute, NUL, backslash and runtime-managed names, refuses non-regular files (FIFOs), skips links in tree/export; ZIP import skips traversal and symlink entries and caps expanded size |
| Infinite loops, CPU burn | `RLIMIT_CPU` (SIGXCPU) + wall-clock timeout; process tree killed (PID namespace / `docker kill`) |
| Memory bombs | `RLIMIT_AS` (C++/Python) + RSS watchdog (all) in local mode; cgroup `--memory` in Docker |
| Fork bombs | `RLIMIT_NPROC` / `--pids-limit`, whole tree killed at the end |
| Output floods, huge files | output cap ⇒ kill; `RLIMIT_FSIZE` / `ulimit fsize` |
| Network abuse / SSRF | **no network** while your program runs (net namespace / `--network none`); only install phases get network; runtime network is opt-in server-side |
| Escaping via `docker.sock` | sandbox containers never get it; **the backend does** — see below |
| Abuse | per-user run rate limit, per-user and global concurrency limits, per-IP auth throttles, nginx `limit_req`, quotas |
| Leftovers | per-run temp dir deleted, containers `rm -f`'d, stale guest data garbage-collected, programs are killed when the WebSocket closes |

**Docker deployment caveats (read these):**

* The backend needs the Docker socket to start sandboxes. Whoever compromises the backend process can start privileged containers = root on the host. Mitigate by running Docker rootless, by putting the backend + sandboxes on a dedicated VM, or by placing a filtering socket proxy in between. gVisor/Kata (`--runtime=runsc`) is a recommended hardening step for hostile public traffic.
* The pip/npm cache volume is shared between projects (same sandbox uid) for speed; a malicious package build could poison it for other users. Set `COMPIELER_SHARED_PKG_CACHE=false` for per-project caches.
* Installs run with network access; `docker/egress-firewall.sh` is what keeps them away from internal addresses. Without it, install-phase code can reach your internal network.

**LocalSandbox is weaker than Docker and says so:** it has no mount namespace/chroot, so world-readable host files remain readable by user code; level **L0** (no `unshare`) also leaves the network open. It is meant for development and CI; `ENV=prod` refuses L0.

## How execution works

1. **Run** → the client saves dirty files, opens a WebSocket (`auth` first message, token never in the URL) and sends `{"type":"run", entry, args, stdin, std, opt}`.
2. **Python**: if `requirements.txt` has packages and its hash changed, `python -m venv --system-site-packages .venv && pip install -r requirements.txt` runs in the *install* phase (cached, skipped when unchanged); then `.venv/bin/python -u -X utf8 <entry>`.
3. **C++**: `g++ -std=c++NN -O2 -Wall -Wextra` over all `*.cpp|cc|cxx` (if several files define `main`, only the selected one is built with the helpers), build cached by a content hash; diagnostics are parsed into *Problems*; then the binary runs. A tiny generated hook unbuffers `stdout` for interactive runs so `printf("x? ")` shows before `scanf`.
4. **JavaScript**: `npm install`/`npm ci` when `package.json` dependencies changed, then `node <entry>` (a small preload makes Node exit after `readline.close()` even though stdin is a pipe).
5. Output is streamed in coalesced frames; stdout and stderr stay separate (*Output* / *Errors* tabs), the *Terminal* shows both. The exit event carries code/signal/reason (`ok, error, timeout, cpu_limit, memory, output_limit, stopped, signal, compile_error, install_failed`) and duration.
6. **Terminal** tab: while a program runs your typed lines go to its stdin (`Ctrl+D` = EOF, `Ctrl+C` = stop). When idle it is a shell in the project sandbox — `pip install x`, `npm install y`, `ls`, … (pip/npm get network; other commands don't).

Pipes, not a PTY, are used so that stdout/stderr stay separate; interactive prompts work because Python flushes `input()` prompts, `cin` is tied to `cout`, and the C++ hook handles `printf/scanf`. Programs that check `isatty()` see a non-terminal.

## API

Interactive docs at `/api/docs`. Main routes (all under `/api`, `Authorization: Bearer <token>`):

`POST /auth/guest · /auth/register · /auth/login · GET /auth/me` ·
`GET|POST /projects · GET|PATCH|DELETE /projects/{id} · POST /projects/import · GET /projects/{id}/export` ·
`GET /projects/{id}/tree · GET|PUT|DELETE …/file · POST …/dir · …/move · …/upload` ·
`POST /format · GET /config · GET /health` ·
`WS /ws/projects/{id}` (protocol documented at the top of `backend/app/api/ws.py`).

## Project layout

```
backend/app/
  main.py config.py db.py models.py schemas.py security.py deps.py ratelimit.py
  api/        auth.py projects.py files.py meta.py ws.py
  services/   projectfs.py (symlink-safe FS)  formatter.py  templates.py
  sandbox/    base.py (supervision)  local.py + launcher.py  docker.py  factory.py
  runner/     session.py (install→compile→run pipeline)  diagnostics.py  manager.py
backend/tests/   real end-to-end tests (server subprocess + WebSocket + sandbox)
frontend/src/    api/ store/ components/ monaco/ lib/
e2e/             Playwright browser tests
docker/          backend + runner Dockerfiles, nginx.conf, egress-firewall.sh
```

## Limitations

* Single backend process (in-memory counters). A WebSocket drop ends the running program (reconnecting does not re-attach).
* No PTY: programs see non-TTY stdio (no curses/readline line editing inside the program; the web terminal edits lines itself).
* `RLIMIT_AS` can break programs that reserve huge virtual address spaces; Node is limited by `--max-old-space-size` and the RSS watchdog instead.
* Non-root local mode has no uid isolation; local mode never has mount isolation.
* `scipy`/`pandas`/`numpy` install from wheels; packages needing system libraries absent from the runner image fail with an explanatory message (add libraries to `docker/runner.Dockerfile`).
* Interactive GUI/plot windows are not available; `matplotlib` uses the `Agg` backend — save figures to files.
* Editor autocompletion for Python/C++ is word/stdlib based (no language server); JavaScript uses Monaco's built-in TypeScript service.

## What was verified, and what was not

Everything below was **actually executed** in the build environment (Linux VM, root, Python 3.13, Node 22, GCC 13, Docker Engine 29, PostgreSQL 16):

| What | How | Result |
|---|---|---|
| Backend suite on the **LocalSandbox** (isolation L1: PID + net namespaces, per-project uid) | `pytest` — real uvicorn subprocess, HTTP + WebSocket, real `pip`/`npm` installs from PyPI/npm | **104 passed** |
| Same suite on the **DockerSandbox** (one container per command, `--network none`, read-only rootfs, caps dropped, pids/memory/cpu limits) | `TEST_SANDBOX=docker pytest` with the runner image built from `docker/runner.Dockerfile` | **104 passed** (incl. pip/npm installs from inside containers, OOM/timeout/fork-bomb, no leftover containers) |
| Docker `volume-subpath` project mounts (what `docker-compose.yml` uses) | `TEST_DATA_DIR=<volume>` + `COMPIELER_DOCKER_DATA_VOLUME=…` | python + C++ suites passed |
| **PostgreSQL** (`asyncpg`) | API suite against a real PG 16 instance | 20 passed, rows verified in PG |
| Frontend production build | `tsc --noEmit` + `vite build` | OK |
| Browser end-to-end (Chromium, desktop + phone viewport) against the built UI and a real backend | Playwright | **19 passed** |

**Offline/standalone app (new):** the standalone web build passes **20 Playwright tests in Chromium** (Python incl. `input()`, numpy, sqlite3, `asyncio.run`, tracebacks; C++ compile/run/diagnostics/multi-file/interactive `scanf`; JavaScript Node modules/readline/ESM/errors; Stop on infinite loops; persistence across reloads; ZIP export/import; shell; image preview). The Android project builds (`assembleRelease` → signed 42 MB APK). **The APK itself has not been run on a phone or emulator** (none was available): behaviour inside the real Android WebView is unverified. A first phone test showed the WebView is *not* cross-origin isolated (`input()` raised `EOFError`), so v1.0.1 added the native stdin channel above; it was verified in Chromium against a simulation of the app (no isolation, fake `AndroidBridge`, answering `/__stdin/<n>`) for Python `input()`, C++ `scanf` and JS `readline`, not on a real device. The Input tab (prefilled stdin) works regardless. v1.1.0 upgraded the engines (Pyodide 0.29 → 314 / Python 3.14, wasm-clang LLVM 8 → YoWASP clang 22 / C++23); that build is likewise only tested in Chromium.

**Not verified** — be aware before deploying:

* The **compose stack as a whole** (nginx container, the backend *container* talking to the host Docker socket, `docker/backend.Dockerfile`, the `docker:27-cli` copy step). Docker Hub rate-limited (HTTP 429) the `nginx`, `node` and `docker` base images in the build environment, so only the pieces above were run. Expect to debug small things on first `docker compose up`.
* `docker/egress-firewall.sh` (needs iptables on a real host), gVisor, TLS and nginx behaviour under load.
* The Docker CI job in `.github/workflows/ci.yml` is marked `continue-on-error` for the same reason; the local-sandbox, frontend and browser jobs are the gating ones.
* Behaviour on non-root hosts without `unshare` (isolation L0) is only covered by the code path warnings, not by the cross-project tests (those need root).
