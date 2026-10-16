#!/usr/bin/env python3
"""TCP bridge so Docker can reach a PDU plugged into the Mac.

The container connects here and sends one line, ``ip:port``. This process,
running on the Mac, dials that address on the local interfaces (USB Ethernet)
and splices the bytes. It never installs a default route.

``UDP ip:port`` relays SNMP instead: each datagram travels over the TCP
connection as a 2-byte big-endian length followed by the payload.
"""
import socket
import struct
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


def _relay_udp(conn, host, port, rest):
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.connect((host, port))
    udp.settimeout(1.0)
    conn.settimeout(None)
    conn.sendall(b"OK\n")
    done = threading.Event()

    def down():
        while not done.is_set():
            try:
                data = udp.recv(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                conn.sendall(struct.pack("!H", len(data)) + data)
            except OSError:
                break
        done.set()

    threading.Thread(target=down, daemon=True).start()
    buf = rest
    try:
        while not done.is_set():
            while len(buf) >= 2:
                n = struct.unpack("!H", buf[:2])[0]
                if len(buf) < 2 + n:
                    break
                udp.send(buf[2:2 + n])
                buf = buf[2 + n:]
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
    except OSError:
        pass
    finally:
        done.set()
        udp.close()


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
        text = line.decode().strip()
        udp = text.startswith("UDP ")
        host, port_s = text[4:].split(":") if udp else text.split(":")
        port = int(port_s)
        if not host.startswith(ALLOWED) or not (1 <= port <= 65535):
            conn.sendall(b"NO\n")
            return
        if udp:
            _relay_udp(conn, host, port, rest)
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
