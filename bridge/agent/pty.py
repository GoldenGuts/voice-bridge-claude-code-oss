"""Run a command in a pseudo-terminal and relay it over plain pipes (stdin -> pty, pty -> stdout).

The bridge runs interactive `claude --remote-control` sessions this way: Remote Control only works in
an interactive session, and Node has no built-in pty. Usage: python3 -I agent/pty.py claude [args...]
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

# A roomy window, so the TUI does not wrap everything (the size starts at 0x0).
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))

stdin = sys.stdin.fileno()
stdout = sys.stdout.fileno()
open_in = True
while True:
    try:
        ready, _, _ = select.select([fd] + ([stdin] if open_in else []), [], [], 1.0)
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break  # the child closed the terminal
        if not data:
            break
        os.write(stdout, data)
    if open_in and stdin in ready:
        data = os.read(stdin, 65536)
        if data:
            os.write(fd, data)
        else:
            open_in = False
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break

_, status = os.waitpid(pid, 0) if not done else (pid, status)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
