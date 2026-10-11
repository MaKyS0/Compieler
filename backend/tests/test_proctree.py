"""The /proc fallback must behave like the psutil implementation (it is what runs on Termux)."""
import os
import subprocess
import sys
import time

import pytest

from app.sandbox import proctree


@pytest.fixture(params=["psutil", "proc"])
def backend(request, monkeypatch):
    if request.param == "psutil" and proctree.psutil is None:
        pytest.skip("psutil not installed")
    monkeypatch.setattr(proctree, "use_psutil", request.param == "psutil")
    return request.param


def test_descendants_rss_and_kill(backend):
    # parent shell with a grandchild that holds ~60 MB
    code = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','x=bytearray(60*1024*1024); import time; time.sleep(60)']); time.sleep(60)"
    p = subprocess.Popen([sys.executable, "-c", code], start_new_session=True)
    try:
        for _ in range(50):
            pids = proctree.descendants(p.pid)
            if len(pids) >= 2 and proctree.rss_bytes(pids) > 50 * 1024 * 1024:
                break
            time.sleep(0.1)
        assert p.pid in pids and len(pids) >= 2
        assert proctree.rss_bytes(pids) > 50 * 1024 * 1024
        proctree.kill_pids(pids)
        p.wait(10)
        time.sleep(0.2)
        assert proctree.descendants(p.pid) == []
    finally:
        p.kill()


def test_task_count_includes_this_process(backend):
    assert proctree.own_task_count(os.geteuid()) >= 1
