"""将固定 TCP 入口接到指定 Unix 通道，保持 WebSocket 与 SSE 的原始字节流。"""
from __future__ import annotations

import select
import socket
import threading
import os
import stat


def connect_unix(destination: str, *, pin=False) -> socket.socket:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(2)
    try:
        if pin:
            # 员工可写 IPC 目录，但不能让宿主代连任意套接字；固定 inode 消除替换竞态。
            descriptor = os.open(destination, os.O_PATH | os.O_NOFOLLOW)
            try:
                if not stat.S_ISSOCK(os.fstat(descriptor).st_mode):
                    raise PermissionError("员工通信入口不是独立套接字。")
                connection.connect(f"/proc/self/fd/{descriptor}")
            finally:
                os.close(descriptor)
        else:
            connection.connect(destination)
        return connection
    except BaseException:
        connection.close()
        raise


class SocketRelay:
    def __init__(self, listener: socket.socket, destination: str | tuple[str, int], *, pin_destination=False):
        self.listener = listener
        self.destination = destination
        self.pin_destination = pin_destination
        self.closed = threading.Event()
        self.lock = threading.Lock()
        self.connections: set[socket.socket] = set()
        self.slots = threading.BoundedSemaphore(128)
        self.thread = threading.Thread(target=self._accept, daemon=True)

    def start(self):
        self.listener.settimeout(0.25)
        self.thread.start()

    def close(self):
        self.closed.set()
        self.listener.close()
        with self.lock:
            for connection in self.connections:
                connection.close()
        if self.thread.is_alive():
            self.thread.join(timeout=1)

    def _accept(self):
        while not self.closed.is_set():
            try:
                incoming, _ = self.listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            if not self.slots.acquire(blocking=False):
                incoming.close()
                continue
            with self.lock:
                if self.closed.is_set():
                    incoming.close(); self.slots.release(); break
                self.connections.add(incoming)
            threading.Thread(target=self._forward, args=(incoming,), daemon=True).start()

    def _forward(self, incoming):
        outgoing = None
        try:
            outgoing = (socket.create_connection(self.destination, timeout=2) if isinstance(self.destination, tuple)
                        else connect_unix(self.destination, pin=self.pin_destination))
            with self.lock:
                if self.closed.is_set():
                    return
                self.connections.add(outgoing)
            sockets = (incoming, outgoing)
            peer = {incoming: outgoing, outgoing: incoming}
            pending = {incoming: bytearray(), outgoing: bytearray()}
            ended, shut = set(), set()
            for connection in sockets:
                connection.setblocking(False)
            while not self.closed.is_set():
                for connection in ended:
                    target = peer[connection]
                    if target not in shut and not pending[target]:
                        target.shutdown(socket.SHUT_WR)
                        shut.add(target)
                if len(shut) == 2:
                    break
                readable = [s for s in sockets if s not in ended and len(pending[peer[s]]) < 262144]
                writable = [s for s in sockets if pending[s]]
                reads, writes, _ = select.select(readable, writable, [], 0.25)
                for connection in reads:
                    data = connection.recv(65536)
                    if data:
                        pending[peer[connection]].extend(data)
                    else:
                        ended.add(connection)
                for connection in writes:
                    sent = connection.send(pending[connection])
                    del pending[connection][:sent]
        except (OSError, ValueError):
            # 客户端断连、容器退出和服务撤销都终止同一条字节通道。
            pass
        finally:
            with self.lock:
                self.connections.discard(incoming)
                self.connections.discard(outgoing)
            incoming.close()
            if outgoing is not None:
                outgoing.close()
            self.slots.release()
