"""真实 TCP 与 Unix 通道应保留双向增量、半关闭和主动撤销。"""
import importlib.util
from pathlib import Path
import socket
import threading
import tempfile

import pytest


def test_relay_preserves_incremental_half_closed_stream_and_revokes_connections(tmp_path):
    source = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/worker_relay.py"
    spec = importlib.util.spec_from_file_location("studio_worker_relay", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    temporary = tempfile.TemporaryDirectory(prefix="relay-")
    socket_path = str(Path(temporary.name) / "backend.sock")
    target = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    target.bind(socket_path); target.listen(2); target.settimeout(5)
    listener = socket.socket(); listener.bind(("127.0.0.1", 0)); listener.listen(2)
    address = listener.getsockname()
    relay = module.SocketRelay(listener, socket_path)
    relay.start()
    got_first, finish = threading.Event(), threading.Event()
    def backend():
        connection, _ = target.accept()
        with connection:
            assert connection.recv(6) == b"first!"
            connection.sendall(b"delta1")
            got_first.set()
            finish.wait(5)
            assert connection.recv(6) == b"second"
            assert connection.recv(1) == b""
            connection.sendall(b"delta2")
    thread = threading.Thread(target=backend); thread.start()
    try:
        with socket.create_connection(address, timeout=5) as connection:
            connection.sendall(b"first!")
            assert connection.recv(6) == b"delta1"
            assert got_first.wait(5)
            connection.sendall(b"second"); connection.shutdown(socket.SHUT_WR); finish.set()
            assert connection.recv(6) == b"delta2"
            assert connection.recv(1) == b""
        with socket.create_connection(address, timeout=5) as pending:
            peer, _ = target.accept()
            with peer:
                relay.close()
                assert pending.recv(1) == b""
    finally:
        finish.set(); relay.close(); target.close(); thread.join(5); temporary.cleanup()
    assert not thread.is_alive()


@pytest.mark.platforms("linux")
def test_parent_relay_refuses_worker_symlink_to_another_host_socket():
    source = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/worker_relay.py"
    spec = importlib.util.spec_from_file_location("studio_pinned_relay", source)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix="relay-pin-") as root:
        target = Path(root) / "actual.sock"
        server = socket.socket(socket.AF_UNIX); server.bind(str(target)); server.listen(1); server.settimeout(2)
        redirect = Path(root) / "backend.sock"; redirect.symlink_to(target)
        try:
            with pytest.raises(OSError):
                module.connect_unix(str(redirect), pin=True)
            with module.connect_unix(str(target), pin=True) as client:
                peer, _ = server.accept()
                with peer:
                    client.sendall(b"own"); assert peer.recv(3) == b"own"
        finally:
            server.close()


def test_unix_ingress_reaches_backend_as_real_loopback_peer():
    source = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/worker_relay.py"
    spec = importlib.util.spec_from_file_location("studio_loopback_relay", source)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix="relay-peer-") as root:
        backend = socket.socket(); backend.bind(("127.0.0.1", 0)); backend.listen(1); backend.settimeout(2)
        ingress = socket.socket(socket.AF_UNIX); ingress.bind(str(Path(root) / "entry.sock")); ingress.listen(1)
        relay = module.SocketRelay(ingress, backend.getsockname()); relay.start()
        client = socket.socket(socket.AF_UNIX); client.settimeout(2)
        try:
            client.connect(str(Path(root) / "entry.sock"))
            client.sendall(b"request")
            peer, address = backend.accept()
            with peer:
                assert address[0] == "127.0.0.1"
                assert peer.recv(7) == b"request"
                peer.sendall(b"reply")
                assert client.recv(5) == b"reply"
        finally:
            client.close(); relay.close(); backend.close()
