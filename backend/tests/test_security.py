"""Security properties, checked by actually attacking the running service."""
import asyncio
import io
import json
import time
import uuid
import zipfile

import httpx
import pytest
import websockets

from .conftest import SECRET, live_processes_with, needs_root


def has_netns(server) -> bool:
    return httpx.get(f"{server.http}/api/config").json()["sandbox"].get("network_namespace", True)


# --------------------------------------------------------------------- secrets
async def test_backend_secrets_are_not_visible(user, server):
    code = f"""
import os, glob
env = dict(os.environ)
print("ENV_HAS_SECRET", any("{SECRET}" in v for v in env.values()), any(k.startswith("COMPIELER") and k != "COMPIELER_UNBUFFERED" for k in env))
for target in ["{server.data_dir}/private/.secret_key", "{server.data_dir}/private/compieler.db"]:
    try:
        open(target, "rb").read(); print("READ", target)
    except Exception as e:
        print("DENIED", type(e).__name__)
leak = False
for p in glob.glob("/proc/[0-9]*/environ"):
    try:
        if b"{SECRET}" in open(p, "rb").read(): leak = True
    except Exception: pass
print("PROC_LEAK", leak)
"""
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py")
    assert "ENV_HAS_SECRET False False" in r.stdout, r.all_text
    assert "PROC_LEAK False" in r.stdout
    if "READ" in r.stdout:  # only acceptable when not root (nothing to separate)
        import os
        assert os.geteuid() != 0
    else:
        assert r.stdout.count("DENIED PermissionError") == 2, r.stdout


# --------------------------------------------------------------------- tenant isolation
async def test_other_users_cannot_access_a_project_over_http(new_user):
    alice, mallory = new_user(), new_user()
    pid = alice.create_project("python", {"main.py": "print('alice secret')"})
    for method, path, kw in [
        ("GET", f"/projects/{pid}", {}),
        ("PATCH", f"/projects/{pid}", {"json": {"name": "pwn"}}),
        ("DELETE", f"/projects/{pid}", {}),
        ("GET", f"/projects/{pid}/tree", {}),
        ("GET", f"/projects/{pid}/file", {"params": {"path": "main.py"}}),
        ("PUT", f"/projects/{pid}/file", {"json": {"path": "main.py", "content": "evil"}}),
        ("DELETE", f"/projects/{pid}/file", {"params": {"path": "main.py"}}),
        ("POST", f"/projects/{pid}/move", {"json": {"src": "main.py", "dst": "x.py"}}),
        ("GET", f"/projects/{pid}/export", {}),
    ]:
        r = mallory.http.request(method, path, **kw)
        assert r.status_code == 404, (method, path, r.status_code, r.text)
    assert pid not in [p["id"] for p in mallory.http.get("/projects").json()]
    assert alice.http.get(f"/projects/{pid}/file", params={"path": "main.py"}).json()["content"] == "print('alice secret')"


async def test_unauthenticated_and_forged_tokens_are_rejected(user, server):
    pid = user.create_project("python", {"main.py": "1"})
    anon = httpx.Client(base_url=server.http + "/api")
    assert anon.get("/projects").status_code == 401
    assert anon.get(f"/projects/{pid}/tree").status_code == 401
    import jwt
    forged = jwt.encode({"sub": str(user.id), "exp": int(time.time()) + 999}, "wrong-key", algorithm="HS256")
    r = anon.get("/projects", headers={"Authorization": f"Bearer {forged}"})
    assert r.status_code == 401
    r = anon.get("/projects", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401


async def test_other_users_cannot_attach_to_a_project_over_websocket(new_user, server):
    alice, mallory = new_user(), new_user()
    pid = alice.create_project("python", {"main.py": "print(1)"})
    ws = await websockets.connect(f"{server.ws}/api/ws/projects/{pid}")
    await ws.send(json.dumps({"type": "auth", "token": mallory.token}))
    with pytest.raises(websockets.ConnectionClosed) as e:
        await asyncio.wait_for(ws.recv(), 5)
    assert e.value.rcvd.code == 4404
    # no token at all
    ws = await websockets.connect(f"{server.ws}/api/ws/projects/{pid}")
    await ws.send(json.dumps({"type": "run", "entry": "main.py"}))
    with pytest.raises(websockets.ConnectionClosed) as e:
        await asyncio.wait_for(ws.recv(), 5)
    assert e.value.rcvd.code == 4401


@needs_root
async def test_sandboxed_code_cannot_read_other_projects(new_user, server):
    alice, mallory = new_user(), new_user()
    apid = alice.create_project("python", {"main.py": "x", "secret.txt": "alice-private-data"})
    mpid = mallory.create_project("python", {"main.py": f"""
import os
for p in ["{server.project_dir(apid)}/secret.txt", "{server.project_dir(apid)}"]:
    try:
        print("LEAK", os.listdir(p) if os.path.isdir(p) else open(p).read())
    except Exception as e:
        print("DENIED", type(e).__name__)
try: print("LEAK", os.listdir("{server.data_dir}/projects"))
except Exception as e: print("LIST_DENIED", type(e).__name__)
try: open("{server.project_dir(apid)}/planted", "w").write("x"); print("LEAK-WRITE")
except Exception as e: print("WRITE_DENIED", type(e).__name__)
"""})
    r = await mallory.run(mpid, entry="main.py")
    assert "LEAK" not in r.stdout, r.stdout
    assert r.stdout.count("DENIED") >= 3
    assert not (server.project_dir(apid) / "planted").exists()


# --------------------------------------------------------------------- path handling
@pytest.mark.parametrize("bad", [
    "../outside.txt", "a/../../outside.txt", "/etc/passwd", "a\\b", "x\x00y", "", ".", "..",
    ".venv/bin/python", "node_modules/x.js", ".compieler/build/app", "a/./b",
])
async def test_path_traversal_and_reserved_names_are_rejected(user, bad):
    pid = user.create_project("python", {"main.py": "1"})
    assert user.http.put(f"/projects/{pid}/file", json={"path": bad, "content": "x"}).status_code in (400, 422)
    assert user.http.get(f"/projects/{pid}/file", params={"path": bad}).status_code in (400, 404, 422)
    assert user.http.post(f"/projects/{pid}/dir", json={"path": bad}).status_code in (400, 422)
    assert user.http.post(f"/projects/{pid}/move", json={"src": "main.py", "dst": bad}).status_code in (400, 422)
    assert user.http.delete(f"/projects/{pid}/file", params={"path": bad}).status_code in (400, 404, 422)


async def test_symlinks_planted_by_user_code_cannot_expose_host_files(user, server, tmp_path_factory):
    outside = server.data_dir / "host_secret.txt"
    outside.write_text("HOST-SECRET")
    outside.chmod(0o644)
    code = f"""
import os
os.symlink("{outside}", "link_file")
os.symlink("/etc", "link_dir")
os.symlink("../../..", "link_up")
os.mkfifo("pipe")
print("done")
"""
    pid = user.create_project("python", {"main.py": code})
    assert (await user.run(pid, entry="main.py")).stdout == "done\n"
    tree = {e["path"] for e in user.http.get(f"/projects/{pid}/tree").json()}
    assert tree == {"main.py"}, tree  # links and fifos are invisible
    for p in ("link_file", "link_dir/hostname", "link_up/x", "pipe"):
        r = user.http.get(f"/projects/{pid}/file", params={"path": p})
        assert r.status_code in (400, 404) and "HOST-SECRET" not in r.text, (p, r.text)
    # writing through a symlinked directory must not create files outside the project
    r = user.http.put(f"/projects/{pid}/file", json={"path": "link_dir/pwned.txt", "content": "x"})
    assert r.status_code in (400, 404, 409)
    import os
    assert not os.path.exists("/etc/pwned.txt")
    # overwriting a symlink replaces the link, it never writes into its target
    user.http.put(f"/projects/{pid}/file", json={"path": "link_file", "content": "overwritten"})
    assert outside.read_text() == "HOST-SECRET"
    # exports skip links as well
    z = zipfile.ZipFile(io.BytesIO(user.http.get(f"/projects/{pid}/export").content))
    assert all("HOST-SECRET" not in z.read(n).decode("utf-8", "ignore") for n in z.namelist() if not n.endswith("/"))
    assert "link_dir" not in " ".join(z.namelist())


async def test_zip_slip_and_symlink_entries_are_ignored_on_import(user, server):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("main.py", "print('imported')")
        z.writestr("../../evil.txt", "evil")
        z.writestr("/abs/evil.txt", "evil")
        z.writestr("ok/nested.py", "x = 1")
        z.writestr(".venv/bin/evil", "x")
        info = zipfile.ZipInfo("sym")
        info.create_system = 3
        info.external_attr = 0o120777 << 16
        z.writestr(info, "/etc/passwd")
    r = user.http.post("/projects/import", files={"file": ("p.zip", buf.getvalue())}, data={"name": "imp"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    tree = {e["path"] for e in user.http.get(f"/projects/{pid}/tree").json() if e["type"] == "file"}
    assert tree == {"main.py", "ok/nested.py"}, tree
    assert not (server.data_dir.parent / "evil.txt").exists()


async def test_zip_bomb_is_refused(user):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("big.txt", b"0" * (150 * 1024 * 1024))
    assert len(buf.getvalue()) < 1_000_000
    r = user.http.post("/projects/import", files={"file": ("bomb.zip", buf.getvalue())})
    assert r.status_code == 413


async def test_file_size_and_count_quotas(user):
    pid = user.create_project("python", {"main.py": "1"})
    r = user.http.put(f"/projects/{pid}/file", json={"path": "big.txt", "content": "x" * (3 * 1024 * 1024)})
    assert r.status_code == 413


# --------------------------------------------------------------------- resource limits
async def test_infinite_loop_is_killed_by_timeout(user):
    pid = user.create_project("python", {"main.py": "print('start', flush=True)\nwhile True:\n    pass\n"})
    t0 = time.time()
    r = await user.run(pid, entry="main.py", timeout=3)
    assert r.exit["reason"] == "timeout", r.exit
    assert 2.5 < time.time() - t0 < 12
    assert "start" in r.stdout and "Time limit" in r.system


async def test_sleeping_program_is_killed_by_wall_clock(user):
    pid = user.create_project("python", {"main.py": "import time\ntime.sleep(1000)\n"})
    r = await user.run(pid, entry="main.py", timeout=2)
    assert r.exit["reason"] == "timeout"


async def test_cpu_time_limit(user):
    pid = user.create_project("python", {"main.py": "while True:\n    pass\n"})
    r = await user.run(pid, entry="main.py", timeout=30, cpu_limit=2)
    assert r.exit["reason"] == "cpu_limit", r.exit
    assert r.exit["duration_ms"] < 8000


async def test_python_memory_bomb_is_stopped(user):
    code = "chunks = []\nwhile True:\n    chunks.append(bytearray(50 * 1024 * 1024))\n"
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py", memory_mb=128)
    assert r.exit["reason"] != "ok"
    assert r.exit["duration_ms"] < 15000
    assert "MemoryError" in r.stderr or r.exit["reason"] in ("memory", "signal")


async def test_cpp_memory_bomb_is_stopped(user):
    code = '#include <vector>\n#include <cstring>\nint main(){ std::vector<char*> v; for(;;){ char* p = new char[50<<20]; memset(p, 1, 50<<20); v.push_back(p);} }'
    pid = user.create_project("cpp", {"main.cpp": code})
    r = await user.run(pid, entry="main.cpp", memory_mb=128)
    assert r.exit["reason"] in ("memory", "signal", "error"), r.exit
    assert r.exit["duration_ms"] < 15000


async def test_node_memory_bomb_is_stopped(user):
    code = "const a = []; setInterval(() => { a.push(Buffer.alloc(50 * 1024 * 1024, 1)); }, 1);"
    pid = user.create_project("javascript", {"index.js": code})
    r = await user.run(pid, entry="index.js", memory_mb=128)
    assert r.exit["reason"] in ("memory", "signal", "error"), r.exit
    assert r.exit["duration_ms"] < 15000


async def test_output_flood_is_cut_off(user):
    pid = user.create_project("python", {"main.py": "while True:\n    print('x' * 1000)\n"})
    r = await user.run(pid, entry="main.py")
    assert r.exit["reason"] == "output_limit", r.exit
    assert len(r.stdout) <= 200_000
    assert "Output exceeded" in r.system


async def test_fork_bomb_is_contained(user):
    code = "import os, time\nfor i in range(10000):\n    try:\n        if os.fork() == 0:\n            time.sleep(30); os._exit(0)\n    except OSError:\n        print('fork refused at', i); break\n"
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py", timeout=10)
    assert "fork refused" in r.stdout or r.exit["reason"] != "ok", r.all_text
    await asyncio.sleep(1)


async def test_huge_file_write_is_limited(user):
    code = "f = open('big.bin', 'wb')\nfor _ in range(200):\n    f.write(b'0' * (1024 * 1024)); f.flush()\nprint('wrote everything')\n"
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py")
    assert "wrote everything" not in r.stdout
    assert r.exit["reason"] in ("signal", "error")


async def test_network_is_disabled_by_default(user, server):
    if not has_netns(server):
        pytest.skip("no network namespace on this host (isolation level L0)")
    code = """
import socket, urllib.request
for host in [("1.1.1.1", 53), ("8.8.8.8", 443), ("169.254.169.254", 80)]:
    try:
        socket.create_connection(host, timeout=3); print("CONNECTED", host)
    except OSError as e:
        print("blocked", host[0])
try:
    urllib.request.urlopen("http://example.com", timeout=3); print("HTTP-OK")
except Exception as e:
    print("http blocked")
"""
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py")
    assert "CONNECTED" not in r.stdout and "HTTP-OK" not in r.stdout, r.stdout
    assert r.stdout.count("blocked") >= 4


async def test_runtime_network_flag_is_ignored_when_server_forbids_it(user, server):
    if not has_netns(server):
        pytest.skip("no network namespace")
    pid = user.create_project("python", {"main.py": "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 53), timeout=3); print('CONNECTED')\nexcept OSError: print('blocked')"})
    r = await user.run(pid, entry="main.py", network=True)
    assert r.stdout == "blocked\n" and "disabled on this server" in r.all_text


# --------------------------------------------------------------------- lifecycle / cleanup
async def test_stop_while_waiting_for_input(user):
    pid = user.create_project("python", {"main.py": "x = input('waiting> ')\nprint('never')"})
    r = await user.execute(pid, {"type": "run", "entry": "main.py"}, script=[("waiting> ", {"type": "stop"})])
    assert r.exit["reason"] == "stopped"
    assert "never" not in r.stdout


async def test_stop_kills_infinite_loop_quickly(user):
    pid = user.create_project("python", {"main.py": "print('go', flush=True)\nwhile True: pass"})
    t0 = time.time()
    r = await user.execute(pid, {"type": "run", "entry": "main.py"}, script=[("go", {"type": "stop"})])
    assert r.exit["reason"] == "stopped" and time.time() - t0 < 5


async def test_background_processes_do_not_survive_the_run(user):
    marker = "MARKER" + uuid.uuid4().hex
    code = f"""
import subprocess, sys, time
subprocess.Popen([sys.executable, "-c", "import time; time.sleep(999)  # {marker}"], start_new_session=True)
subprocess.Popen(["sleep", "999"], start_new_session=True)
print("spawned", flush=True)
time.sleep(999)
"""
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py", timeout=3)
    assert r.exit["reason"] == "timeout"
    for _ in range(20):
        if not live_processes_with(marker):
            break
        await asyncio.sleep(0.25)
    assert live_processes_with(marker) == []


async def test_background_process_holding_the_pipe_does_not_hang_the_run(user):
    marker = "PIPEHOLD" + uuid.uuid4().hex
    code = f"""
import subprocess, sys
subprocess.Popen([sys.executable, "-c", "import time; time.sleep(999)  # {marker}"])
print("parent exits now")
"""
    pid = user.create_project("python", {"main.py": code})
    t0 = time.time()
    r = await user.run(pid, entry="main.py", timeout=20)
    assert "parent exits now" in r.stdout
    assert time.time() - t0 < 10
    await asyncio.sleep(0.5)
    assert live_processes_with(marker) == []


async def test_closing_the_websocket_terminates_the_program(user):
    code = "import time\nprint('up', flush=True)\nwhile True:\n    time.sleep(0.1)\n"
    pid = user.create_project("python", {"main.py": code})
    ws = await user.session(pid)
    await ws.send(json.dumps({"type": "run", "entry": "main.py"}))
    while "up" not in json.loads(await asyncio.wait_for(ws.recv(), 10)).get("data", ""):
        pass
    await ws.close()
    for _ in range(40):  # the supervisor must notice the disconnect and kill the tree
        if not live_processes_with(f"/projects/{pid}"):
            break
        await asyncio.sleep(0.25)
    assert live_processes_with(f"/projects/{pid}") == []


async def test_temp_directories_are_removed_after_runs(user, server):
    pid = user.create_project("python", {"main.py": "import tempfile, os\nd = tempfile.mkdtemp(); open(d + '/f', 'w').write('x'); print(d)"})
    r = await user.run(pid, entry="main.py")
    tmp_path = r.stdout.strip()
    import os
    assert not os.path.exists(tmp_path)
    assert [p for p in (server.data_dir / "tmp").iterdir() if p.name.startswith("run-")] == []


async def test_parallel_run_limit_per_user(user):
    pid = user.create_project("python", {"main.py": "import time\nprint('busy', flush=True)\ntime.sleep(30)"})
    sockets = []
    try:
        for _ in range(3):
            ws = await user.session(pid)
            await ws.send(json.dumps({"type": "run", "entry": "main.py"}))
            sockets.append(ws)
            while "busy" not in json.loads(await asyncio.wait_for(ws.recv(), 10)).get("data", ""):
                pass
        ws = await user.session(pid)
        sockets.append(ws)
        await ws.send(json.dumps({"type": "run", "entry": "main.py"}))
        errors = []
        async with asyncio.timeout(10):
            while not errors:
                ev = json.loads(await ws.recv())
                if ev["type"] == "error":
                    errors.append(ev)
        assert errors[0]["code"] == "busy"
    finally:
        for ws in sockets:
            await ws.send(json.dumps({"type": "stop"}))
            await ws.close()


async def test_second_job_on_same_connection_is_refused_while_busy(user):
    pid = user.create_project("python", {"main.py": "import time\nprint('x', flush=True)\ntime.sleep(30)"})
    ws = await user.session(pid)
    await ws.send(json.dumps({"type": "run", "entry": "main.py"}))
    while "x" not in json.loads(await asyncio.wait_for(ws.recv(), 10)).get("data", ""):
        pass
    await ws.send(json.dumps({"type": "run", "entry": "main.py"}))
    got = None
    async with asyncio.timeout(5):
        while got is None:
            ev = json.loads(await ws.recv())
            if ev["type"] == "error":
                got = ev
    assert got["code"] == "busy"
    await ws.send(json.dumps({"type": "stop"}))
    await ws.close()
