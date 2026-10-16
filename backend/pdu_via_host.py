"""Send PDU TCP from this process through the bridge on the Mac.

Docker Desktop does not forward the container onto a USB Ethernet dongle.
When PDUMIND_PDU_VIA=host:port is set, connections to the factory and Agoda
subnets are handed to backend/pdu_tcp_bridge.py running on the Mac.
"""
import os
import socket

_RAW_CONNECT = socket.socket.connect
_RAW_CONNECT_EX = socket.socket.connect_ex
_VIA = (os.getenv("PDUMIND_PDU_VIA") or "").strip()
_PREFIXES = ("192.168.0.", "10.106.76.", "10.106.77.")


def _via_endpoint():
    host, _, port = _VIA.rpartition(":")
    return host, int(port)


def _connect(self, address):
    if not _VIA or not isinstance(address, tuple) or len(address) < 2:
        return _RAW_CONNECT(self, address)
    host, port = address[0], address[1]
    if not isinstance(host, str) or not host.startswith(_PREFIXES):
        return _RAW_CONNECT(self, address)
    proxy_host, proxy_port = _via_endpoint()
    self.settimeout(8)
    _RAW_CONNECT(self, (proxy_host, proxy_port))
    self.sendall(f"{host}:{int(port)}\n".encode())
    buf = b""
    while b"\n" not in buf and len(buf) < 16:
        chunk = self.recv(16 - len(buf))
        if not chunk:
            raise OSError(f"PDU bridge closed before reaching {host}:{port}")
        buf += chunk
    if not buf.startswith(b"OK"):
        raise OSError(f"PDU bridge could not reach {host}:{port}")
    return None


def _connect_ex(self, address):
    """Same bridge as connect(). The login probe uses connect_ex, which Docker cannot route."""
    if not _VIA or not isinstance(address, tuple) or len(address) < 2:
        return _RAW_CONNECT_EX(self, address)
    host = address[0]
    if not isinstance(host, str) or not host.startswith(_PREFIXES):
        return _RAW_CONNECT_EX(self, address)
    try:
        _connect(self, address)
        return 0
    except OSError as exc:
        return exc.errno or 111


def install():
    if _VIA and socket.socket.connect is _RAW_CONNECT:
        socket.socket.connect = _connect
    if _VIA and socket.socket.connect_ex is _RAW_CONNECT_EX:
        socket.socket.connect_ex = _connect_ex


install()
