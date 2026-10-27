#!/usr/bin/env python3
# Runs a command in a pseudo-terminal: stdin goes to it, its screen output comes back on stdout.
# Lines on fd 3 control the terminal: "resize <rows> <cols>". Node has no pty without a native addon.
import fcntl, os, pty, select, signal, struct, sys, termios

rows, cols = int(sys.argv[1]), int(sys.argv[2])
command = sys.argv[3:]


def size(fd, r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))


pid, master = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

size(master, rows, cols)
control = os.fdopen(3, 'r', buffering=1)
reading = [master, sys.stdin.fileno(), control.fileno()]
pending = ''
signal.signal(signal.SIGTERM, lambda *_: (os.kill(pid, signal.SIGTERM), sys.exit(0)))

while True:
    ready, _, _ = select.select(reading, [], [])
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            os.write(master, data)
        else:
            reading.remove(sys.stdin.fileno())
    if control.fileno() in ready:
        chunk = os.read(control.fileno(), 4096).decode()
        if not chunk:
            reading.remove(control.fileno())
            continue
        pending += chunk
        while '\n' in pending:
            line, pending = pending.split('\n', 1)
            parts = line.split()
            if parts and parts[0] == 'resize':
                # the kernel sends SIGWINCH to the terminal's foreground group
                size(master, int(parts[1]), int(parts[2]))

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
