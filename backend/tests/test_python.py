import pytest

from .conftest import needs_root


async def test_stdlib_modules_are_all_importable(user):
    code = """
import importlib, sys
mods = "os sys subprocess pathlib shutil tempfile socket http.client urllib.request threading multiprocessing asyncio json csv sqlite3 re math random statistics datetime collections itertools functools typing logging hashlib zipfile ssl decimal fractions struct unittest".split()
bad = []
for m in mods:
    try: importlib.import_module(m)
    except Exception as e: bad.append((m, repr(e)))
print("BAD", bad)
print("OK", len(mods))
"""
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py")
    assert r.exit["reason"] == "ok", r.all_text
    assert "BAD []" in r.stdout and "OK " in r.stdout


async def test_hello_and_exit_code_zero(user):
    pid = user.create_project("python", {"main.py": "print('hello 🙂 привет')"})
    r = await user.run(pid, entry="main.py")
    assert r.stdout == "hello 🙂 привет\n"
    assert r.exit["code"] == 0 and r.exit["reason"] == "ok"
    assert r.exit["duration_ms"] >= 0


async def test_input_with_prefilled_stdin(user):
    pid = user.create_project("python", {"main.py": 'name = input("Enter your name: ")\nprint(f"Hello, {name}!")\n'})
    r = await user.run(pid, entry="main.py", stdin="Ada\n")
    assert r.stdout == "Enter your name: Hello, Ada!\n"


async def test_interactive_input_during_execution(user):
    code = 'name = input("Name? ")\nage = int(input("Age? "))\nprint(f"{name} will be {age + 1}")\n'
    pid = user.create_project("python", {"main.py": code})
    r = await user.execute(
        pid,
        {"type": "run", "entry": "main.py"},
        script=[("Name? ", {"type": "stdin", "data": "Bob\n"}), ("Age? ", {"type": "stdin", "data": "41\n"})],
    )
    assert r.stdout.endswith("Bob will be 42\n"), r.stdout
    assert r.exit["reason"] == "ok"


async def test_eof_closes_input(user):
    import asyncio, json
    pid = user.create_project("python", {"main.py": "import sys\ndata = sys.stdin.read()\nprint('got', len(data.splitlines()))\n"})
    ws = await user.session(pid)
    await ws.send(json.dumps({"type": "run", "entry": "main.py"}))
    await ws.send(json.dumps({"type": "stdin", "data": "a\nb\nc\n"}))
    await ws.send(json.dumps({"type": "eof"}))
    out = ""
    while True:
        ev = json.loads(await asyncio.wait_for(ws.recv(), 20))
        if ev["type"] == "output" and ev["stream"] == "stdout":
            out += ev["data"]
        if ev["type"] == "exit":
            assert ev["reason"] == "ok"
            break
    assert out == "got 3\n"
    await ws.close()


async def test_exception_traceback_and_problem_marker(user):
    code = "def f():\n    return 1 / 0\n\nprint('before')\nf()\n"
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py")
    assert r.stdout == "before\n"
    assert "ZeroDivisionError: division by zero" in r.stderr
    assert r.exit["reason"] == "error" and r.exit["code"] == 1
    assert r.problems and r.problems[0]["file"] == "main.py" and r.problems[0]["line"] == 2


async def test_syntax_error_is_reported(user):
    pid = user.create_project("python", {"main.py": "print('ok'\n"})
    r = await user.run(pid, entry="main.py")
    assert "SyntaxError" in r.stderr
    assert r.exit["reason"] == "error"
    assert r.problems and r.problems[0]["file"] == "main.py" and r.problems[0]["line"] == 1


async def test_sys_exit_code_is_reported(user):
    pid = user.create_project("python", {"main.py": "import sys\nsys.exit(7)"})
    r = await user.run(pid, entry="main.py")
    assert r.exit["code"] == 7 and r.exit["reason"] == "error"


async def test_missing_module_gives_a_hint(user):
    pid = user.create_project("python", {"main.py": "import definitely_not_installed_pkg"})
    r = await user.run(pid, entry="main.py")
    assert "ModuleNotFoundError" in r.stderr
    assert "definitely_not_installed_pkg" in r.system and "requirements.txt" in r.system


async def test_files_in_project_directory(user):
    code = """
import os, pathlib, shutil, tempfile, subprocess, sys
p = pathlib.Path("data/out.txt"); p.parent.mkdir(exist_ok=True)
p.write_text("héllo")
print(p.read_text(), os.listdir("data"))
print(subprocess.run(["echo", "from-subprocess"], capture_output=True, text=True).stdout.strip())
print(subprocess.run([sys.executable, "-c", "print(40+2)"], capture_output=True, text=True).stdout.strip())
with tempfile.TemporaryDirectory() as d:
    q = pathlib.Path(d) / "x"; q.write_text("t"); print(q.read_text())
print(os.getcwd().endswith(str(os.getcwd().split("/")[-1])))
"""
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py")
    assert r.exit["reason"] == "ok", r.all_text
    assert "héllo ['out.txt']" in r.stdout and "from-subprocess" in r.stdout and "\n42\n" in r.stdout
    # the file written by the program is visible through the file API
    tree = {e["path"] for e in user.http.get(f"/projects/{pid}/tree").json()}
    assert "data/out.txt" in tree
    assert user.http.get(f"/projects/{pid}/file", params={"path": "data/out.txt"}).json()["content"] == "héllo"


async def test_threads_multiprocessing_asyncio_sqlite(user):
    code = """
import asyncio, sqlite3, threading
from multiprocessing import Pool
def sq(x): return x * x
async def main():
    await asyncio.sleep(0.01); return "async-ok"
if __name__ == "__main__":
    out = []
    t = threading.Thread(target=lambda: out.append("thread-ok")); t.start(); t.join()
    with Pool(2) as p: print(p.map(sq, range(5)))
    print(out[0], asyncio.run(main()))
    db = sqlite3.connect("t.db"); db.execute("create table a(x)"); db.execute("insert into a values (5)")
    print(db.execute("select sum(x) from a").fetchone())
"""
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py")
    assert r.exit["reason"] == "ok", r.all_text
    assert "[0, 1, 4, 9, 16]" in r.stdout and "thread-ok async-ok" in r.stdout and "(5,)" in r.stdout


async def test_multiple_files_and_packages(user):
    files = {
        "main.py": "from pkg.helper import triple\nimport util\nprint(triple(util.base()))\n",
        "util.py": "def base():\n    return 14\n",
        "pkg/__init__.py": "",
        "pkg/helper.py": "def triple(x):\n    return 3 * x\n",
    }
    pid = user.create_project("python", files)
    r = await user.run(pid, entry="main.py")
    assert r.stdout == "42\n" and r.exit["reason"] == "ok"


async def test_arguments(user):
    pid = user.create_project("python", {"main.py": "import sys\nprint(sys.argv[1:])"})
    r = await user.run(pid, entry="main.py", args="one 'two words' three")
    assert r.stdout == "['one', 'two words', 'three']\n"


async def test_loopback_works_inside_sandbox(user):
    code = """
import socket, threading
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
port = srv.getsockname()[1]
def serve():
    c, _ = srv.accept(); c.sendall(b"pong"); c.close()
threading.Thread(target=serve).start()
c = socket.create_connection(("127.0.0.1", port), timeout=5)
print(c.recv(10))
"""
    pid = user.create_project("python", {"main.py": code})
    r = await user.run(pid, entry="main.py")
    assert r.stdout == "b'pong'\n", r.all_text


@pytest.mark.network
async def test_pip_install_requests_via_requirements(user):
    pid = user.create_project("python", {
        "requirements.txt": "requests==2.32.3\n",
        "main.py": "import requests, sys\nprint('requests', requests.__version__)\nprint(sys.prefix.endswith('.venv'))\n",
    })
    r = await user.run(pid, entry="main.py")
    assert r.exit["reason"] == "ok", r.all_text
    assert "requests 2.32.3" in r.stdout and "True" in r.stdout
    assert "Installing requirements.txt" in r.system
    # dependencies are reused: second run must not reinstall
    r2 = await user.run(pid, entry="main.py")
    assert r2.exit["reason"] == "ok" and "requests 2.32.3" in r2.stdout
    assert "Installing" not in r2.all_text
    assert r2.exit["duration_ms"] < 5000


@pytest.mark.network
async def test_install_from_packages_panel_updates_requirements(user):
    pid = user.create_project("python", {"main.py": "import six\nprint(six.__version__)"})
    r = await user.execute(pid, {"type": "install", "packages": ["six"]})
    assert r.exit["reason"] == "ok", r.all_text
    assert "six" in user.http.get(f"/projects/{pid}/file", params={"path": "requirements.txt"}).json()["content"]
    r = await user.run(pid, entry="main.py")
    assert r.exit["reason"] == "ok" and r.stdout.strip()


@pytest.mark.network
async def test_pip_failure_is_explained(user):
    pid = user.create_project("python", {"requirements.txt": "no-such-package-xyz-123==9.9.9\n", "main.py": "print(1)"})
    r = await user.run(pid, entry="main.py")
    assert r.exit["reason"] == "install_failed"
    assert "pip could not find a matching release" in r.system
    assert r.stdout == ""


@pytest.mark.network
async def test_terminal_pip_command(user):
    pid = user.create_project("python", {"main.py": "print(1)"})
    r = await user.shell(pid, "pip install six && python -c 'import six; print(\"six-ok\")'")
    assert r.exit["reason"] == "ok", r.all_text
    assert "six-ok" in r.all_text
