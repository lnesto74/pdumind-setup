#!/usr/bin/env python3
"""TCP bridge so Docker can reach a PDU plugged into the Mac.

The container connects here and sends one line, ``ip:port``. This process,
running on the Mac, dials that address on the local interfaces (USB Ethernet)
and splices the bytes. It never installs a default route.
"""
import socket
import threading

LISTEN = ("0.0.0.0", 17990)
ALLOWED = ("192.168.0.", "10.106.76.", "10.106.77.")


def _splice(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        for sock, how in ((src, socket.SHUT_RD), (dst, socket.SHUT_WR)):
            try:
                sock.shutdown(how)
            except Exception:
                pass


def _handle(conn):
    upstream = None
    try:
        conn.settimeout(5)
        buf = b""
        while b"\n" not in buf and len(buf) < 80:
            chunk = conn.recv(80 - len(buf))
            if not chunk:
                return
            buf += chunk
        line, rest = buf.split(b"\n", 1)
        host, port_s = line.decode().strip().split(":")
        port = int(port_s)
        if not host.startswith(ALLOWED) or not (1 <= port <= 65535):
            conn.sendall(b"NO\n")
            return
        upstream = socket.create_connection((host, port), timeout=6)
        conn.settimeout(None)
        upstream.settimeout(None)
        conn.sendall(b"OK\n")
        if rest:
            upstream.sendall(rest)
        threading.Thread(target=_splice, args=(conn, upstream), daemon=True).start()
        _splice(upstream, conn)
    except Exception:
        try:
            conn.sendall(b"NO\n")
        except Exception:
            pass
    finally:
        for sock in (conn, upstream):
            if sock is None:
                continue
            try:
                sock.close()
            except Exception:
                pass


def main():
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(LISTEN)
    server.listen(32)
    while True:
        conn, _addr = server.accept()
        threading.Thread(target=_handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
