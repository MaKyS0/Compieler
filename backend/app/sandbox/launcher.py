"""Tiny privilege-dropping exec helper for the local sandbox.

Runs as root (inside the namespaces set up by ``unshare``), applies resource limits,
drops to the project's uid and ``exec``s the real command. It deliberately imports
nothing from the application so it can run under ``python -I``.
"""
import argparse
import ctypes
import os
import resource
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--uid", type=int, default=-1)
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--cpu", type=int, default=0)
    ap.add_argument("--as-mb", type=int, default=0)
    ap.add_argument("--nproc", type=int, default=0)
    ap.add_argument("--fsize-mb", type=int, default=0)
    ap.add_argument("--nofile", type=int, default=0)
    ap.add_argument("--init", action="store_true", help="act as PID 1: fork the workload, reap orphans")
    ap.add_argument("--lo-up", action="store_true", help="bring up loopback in a fresh net namespace")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        print("launcher: no command", file=sys.stderr)
        return 127

    if a.init:
        # We are PID 1 of a fresh PID namespace. The kernel ignores default-action signals
        # sent to PID 1 (e.g. SIGXCPU from RLIMIT_CPU), so the workload must not be PID 1.
        pid = os.fork()
        if pid != 0:
            code = 1
            while True:
                try:
                    wpid, status = os.wait()
                except ChildProcessError:
                    break
                if wpid == pid:
                    rc = os.waitstatus_to_exitcode(status)
                    code = 128 - rc if rc < 0 else rc
                    break
            return code

    def lim(res, soft, hard=None):
        resource.setrlimit(res, (soft, soft if hard is None else hard))

    if a.lo_up:
        try:
            import fcntl
            import socket
            import struct

            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            # SIOCSIFFLAGS with IFF_UP | IFF_RUNNING
            fcntl.ioctl(sock, 0x8914, struct.pack("16sH14s", b"lo", 0x1 | 0x40, b"\0" * 14))
            sock.close()
        except Exception:
            pass
    try:
        lim(resource.RLIMIT_CORE, 0)
        if a.cpu:
            lim(resource.RLIMIT_CPU, a.cpu, a.cpu + 2)  # SIGXCPU first, SIGKILL later
        if a.as_mb:
            lim(resource.RLIMIT_AS, a.as_mb * 1024 * 1024)
        if a.fsize_mb:
            lim(resource.RLIMIT_FSIZE, a.fsize_mb * 1024 * 1024)
        if a.nofile:
            lim(resource.RLIMIT_NOFILE, a.nofile)
        if a.nproc:
            lim(resource.RLIMIT_NPROC, a.nproc)
        os.chdir(a.cwd)
        os.umask(0o022)
        if a.uid >= 0 and os.geteuid() == 0:
            os.setgroups([])
            os.setgid(a.uid)
            os.setuid(a.uid)
            if os.geteuid() == 0:
                raise RuntimeError("privilege drop failed")
        try:  # no setuid binaries may regain privileges
            ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0)
        except Exception:
            pass
    except Exception as e:  # noqa: BLE001
        print(f"launcher: sandbox setup failed: {e}", file=sys.stderr)
        return 126
    try:
        os.execvp(cmd[0], cmd)
    except FileNotFoundError:
        print(f"{cmd[0]}: command not found", file=sys.stderr)
        return 127
    except PermissionError:
        print(f"{cmd[0]}: permission denied", file=sys.stderr)
        return 126
    return 0


if __name__ == "__main__":
    sys.exit(main())
