"""Linux 员工进程使用无网络容器，模型与前端仅经专用 Unix 通道接入。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile

from seatbelt import _SOURCE_DIRS
from worker_relay import SocketRelay


def container_command(options, ipc, name, port, env):
    """只把代码、解释器和当前账号资料映射入容器；宿主配置目录始终不可见。"""
    image = options.get("linuxWorkerImage", "")
    if not re.fullmatch(r"(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}", image):
        raise ValueError("Linux 员工镜像必须使用固定 sha256 标识。")
    repo = Path(options["repoRoot"]).resolve(strict=True)
    home = Path(options["home"]).resolve(strict=True)
    if repo == home or repo in home.parents or home in repo.parents:
        raise ValueError("员工资料和程序目录必须独立。")
    dependencies = {Path(item).resolve(strict=True) for item in options["pythonPaths"]}
    if not dependencies:
        raise ValueError("必须指定员工 Python 运行目录。")
    for dependency in dependencies:
        if dependency in (Path("/"), Path.home().resolve(), repo, home) or dependency in home.parents or dependency in repo.parents:
            raise ValueError("Python 运行目录不能包含宿主资料或程序根目录。")
    protected = [home / name for name in ("config.yaml", ".env", "SOUL.md", "plugins", "skills")]
    if any(item.is_symlink() or not item.exists() for item in protected):
        raise ValueError("账号可信配置不能缺失或使用符号链接。")
    command = ["run", "--rm", "--init", "--name", name, "--network", "none", "--read-only",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256",
               "--user", f"{os.getuid()}:{os.getgid()}", "--workdir", str(home / "workspace")]
    def mount(source, target=None, readonly=True):
        source = Path(source)
        values = (str(source), str(target or source))
        if any("," in value or any(ord(char) < 32 for char in value) for value in values):
            raise ValueError("容器路径包含不支持的字符。")
        command.extend(["--mount", f"type=bind,src={values[0]},dst={values[1]}" + (",readonly" if readonly else "")])
    sources = [repo / name for name in _SOURCE_DIRS if (repo / name).is_dir()]
    sources += list(repo.glob("*.py"))
    sources += [repo / name for name in ("pyproject.toml", "plugin-catalog/removed.yaml") if (repo / name).is_file()]
    for source in [*sources, *sorted(dependencies)]:
        mount(source)
    mount(home, readonly=False)
    for source in protected:
        mount(source)
    mount(ipc, "/run/studio-ipc", readonly=False)
    mount(options["brokerSocket"], "/run/studio-broker.sock")
    for key in env:
        command.extend(["--env", key])
    command += ["--entrypoint", options.get("python", sys.executable), image,
                str(repo / "apps/drama-studio/server/linux_worker.py"), "--inside", str(port), str(options["brokerPort"])]
    return command


def launch(options, listener, env):
    from hermes_platform.resolver import locate_command

    docker = locate_command("docker")
    if not docker.found or os.getuid() == 0:
        raise RuntimeError("员工容器需要可用的 Docker 和非 root 服务账号。")
    root = Path(options["ipcRoot"])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="worker-", dir=root) as directory:
        ipc = Path(directory)
        name = "studio-worker-" + secrets.token_hex(12)
        port = listener.getsockname()[1]
        command = [*docker.command, *container_command(options, ipc, name, port, env)]
        relay = SocketRelay(listener, str(ipc / "backend.sock"), pin_destination=True)
        # Docker 客户端只接收清空后的宿主环境和员工限定凭证；供应商密钥留在 Node 代理。
        child = subprocess.Popen(command, env={**os.environ, **env}, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=sys.stderr)
        def terminate(*_):
            child.terminate()
        previous = {sig: signal.signal(sig, terminate) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            relay.start()
            print(json.dumps({"port": port, "pid": child.pid}), flush=True)
            return child.wait()
        finally:
            relay.close()
            # docker run 的客户端可能先退出；显式回收独立容器及其全部后代。
            subprocess.run([*docker.command, "rm", "--force", name], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3,
                           start_new_session=True)
            for sig, handler in previous.items():
                signal.signal(sig, handler)


def inside(port, broker_port):
    broker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    broker.bind(("127.0.0.1", broker_port)); broker.listen(128)
    relay = SocketRelay(broker, "/run/studio-broker.sock")
    ingress = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    ingress.bind("/run/studio-ipc/backend.sock"); ingress.listen(128)
    os.chmod("/run/studio-ipc/backend.sock", 0o600)
    # Hermes 原生 WebSocket 门禁要求真实回环 peer；Unix ASGI scope 的 client 为 None。
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", port)); listener.listen(128)
    backend_relay = SocketRelay(ingress, listener.getsockname())
    try:
        relay.start(); backend_relay.start()
        import runtime
        # runtime 接管句柄，避免 Uvicorn 退出后重复关闭已释放的描述符。
        descriptor = listener.detach()
        sys.argv = [str(Path(runtime.__file__)), "--worker-fd", str(descriptor), "--port", str(port)]
        runtime.main()
    finally:
        relay.close(); backend_relay.close(); listener.close()


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "--inside":
        raise SystemExit("此入口仅供隔离容器调用。")
    inside(int(sys.argv[2]), int(sys.argv[3]))
