#!/usr/bin/env python3
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

mode, repo, cwd, proof, first_id, expected_url = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 110, 0, 0))
process = subprocess.Popen(
    ["bun", "run", f"{repo}/packages/cli/src/cli/index.ts", "tui"],
    cwd=cwd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    start_new_session=True,
    env={**os.environ, "TERM": "xterm-256color"},
)
os.close(slave)
trace = Path(proof) / f"tui-{mode}.txt"
output = bytearray()


def await_output(pattern: bytes, since: int = 0) -> None:
    deadline = time.monotonic() + 20
    while re.search(pattern, output[since:], re.DOTALL) is None:
        if time.monotonic() >= deadline or process.poll() is not None:
            raise RuntimeError(f"TUI did not show {pattern!r}; inspect {trace}")
        if select.select([master], [], [], 0.1)[0]:
            output.extend(os.read(master, 65_536))


try:
    if mode == "list-open":
        await_output(re.escape(first_id.encode()))
        selected_at = len(output)
        os.write(master, b"j")
        await_output(re.escape(expected_url.encode()), selected_at)
        os.write(master, b"o")
        opened = Path(proof) / "tui-opened.txt"
        deadline = time.monotonic() + 10
        while not opened.exists():
            if time.monotonic() >= deadline or process.poll() is not None:
                raise RuntimeError(f"TUI did not open a deployment; inspect {trace}")
            if select.select([master], [], [], 0.1)[0]:
                output.extend(os.read(master, 65_536))
        if opened.read_text().strip() != expected_url:
            raise RuntimeError(f"TUI opened the wrong deployment; inspect {opened}")
    elif mode == "unreachable":
        await_output(rb"Could not load deployments from this server\.")
        await_output(b"devver server status")
    else:
        raise ValueError(f"Unknown mode: {mode}")
    os.write(master, b"q")
    deadline = time.monotonic() + 10
    while process.poll() is None:
        if time.monotonic() >= deadline:
            raise RuntimeError(f"TUI did not exit; inspect {trace}")
        if select.select([master], [], [], 0.1)[0]:
            try:
                output.extend(os.read(master, 65_536))
            except OSError:
                if process.poll() is None:
                    raise
    if process.returncode != 0:
        raise RuntimeError(f"TUI exited with {process.returncode}; inspect {trace}")
finally:
    trace.write_bytes(output)
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
