"""Linux 容器策略拒绝可变镜像和超范围挂载，并在原生 Linux 验证实际权限。"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import json
import socket
import subprocess
import sys
import threading
import tempfile
import time
import asyncio

import pytest

REPO = Path(__file__).resolve().parents[3]


def _module():
    location = REPO / "apps/drama-studio/server/linux_worker.py"
    spec = importlib.util.spec_from_file_location("studio_linux_worker", location)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(location.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def test_mount_policy_rejects_mutable_images_and_foreign_data_roots(tmp_path):
    module = _module()
    home = tmp_path / "workers/studio-test"; home.mkdir(parents=True)
    ipc = tmp_path / "ipc"; ipc.mkdir()
    broker = tmp_path / "broker.sock"; broker.touch()
    for name in ("config.yaml", ".env", "SOUL.md"):
        (home / name).write_text("fixture")
    for name in ("plugins", "skills", "workspace"):
        (home / name).mkdir()
    options = {"repoRoot": str(REPO), "home": str(home), "pythonPaths": [sys.base_prefix],
               "linuxWorkerImage": "sha256:" + "a" * 64, "brokerSocket": str(broker)}
    for image in ("ubuntu:latest", "ubuntu:24.04", "", "--privileged"):
        with pytest.raises(ValueError):
            module.container_command({**options, "linuxWorkerImage": image}, ipc, "fixture", 60001, {})
    for broad in ("/", str(Path.home()), str(tmp_path), str(REPO)):
        with pytest.raises(ValueError):
            module.container_command({**options, "pythonPaths": [broad]}, ipc, "fixture", 60001, {})
    target = tmp_path / "foreign.env"; target.write_text("foreign")
    (home / ".env").unlink(); (home / ".env").symlink_to(target)
    with pytest.raises(ValueError):
        module.container_command(options, ipc, "fixture", 60001, {})


@pytest.mark.platforms("linux")
def test_real_container_isolates_accounts_but_supports_python_pdf_and_incremental_ipc(tmp_path):
    from hermes_platform.resolver import locate_command

    image = os.environ.get("HERMES_TEST_IMAGE")
    if not image:
        pytest.skip("真实 Linux 验收需通过 HERMES_TEST_IMAGE 指定固定员工镜像。")
    docker = locate_command("docker")
    assert docker.found and os.getuid() != 0
    module = _module()
    home = tmp_path / "workers/studio-fixture"; home.mkdir(parents=True)
    (home / "config.yaml").write_text("model: {provider: custom, default: fixture-model}\n")
    (home / ".env").write_text("FIXTURE_SCOPE_TOKEN=not-a-real-key\n")
    (home / "SOUL.md").write_text("测试身份")
    for name in ("plugins", "skills", "workspace", "tmp", "runtime"):
        (home / name).mkdir()
    foreign = tmp_path / "foreign.env"; foreign.write_text("FOREIGN_DATA_CANARY")
    (home / "foreign-link").symlink_to(foreign)
    pdf_spec = importlib.util.spec_from_file_location("studio_pdf_fixture", Path(__file__).with_name("test_seatbelt.py"))
    pdf_module = importlib.util.module_from_spec(pdf_spec); pdf_spec.loader.exec_module(pdf_module)
    (home / "source.pdf").write_bytes(pdf_module._pdf())
    temporary = tempfile.TemporaryDirectory(prefix="studio-live-")
    ipc = Path(temporary.name); broker_path = ipc / "broker.sock"
    broker = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); broker.bind(str(broker_path)); broker.listen(1); broker.settimeout(15)
    foreign_tcp = socket.socket(); foreign_tcp.bind(("127.0.0.1", 0)); foreign_tcp.listen(1)
    victim = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                              env={**os.environ, "PRIVATE_PROCESS_CANARY": "FOREIGN_DATA_CANARY"})
    first, release = threading.Event(), threading.Event()
    def serve():
        connection, _ = broker.accept()
        with connection:
            assert connection.recv(32) == b"SCOPED_REQUEST"
            connection.sendall(b"first")
            first.set(); release.wait(10)
            connection.sendall(b"second")
    server = threading.Thread(target=serve, daemon=True); server.start()
    options = {"repoRoot": str(REPO), "home": str(home), "python": sys.executable,
               "pythonPaths": list({sys.prefix, sys.base_prefix}), "linuxWorkerImage": image,
               "brokerSocket": str(broker_path), "brokerPort": 64000}
    env = {"HOME": str(home), "HERMES_HOME": str(home), "TMPDIR": str(home / "tmp"),
           "PYTHONPATH": os.pathsep.join([str(REPO), str(REPO / "apps/drama-studio/server"), *[p for p in sys.path if "site-packages" in p]]),
           "PYTHONDONTWRITEBYTECODE": "1", "HERMES_RUNTIME_DIR": str(home / "runtime"), "PATH": "/usr/bin:/bin"}
    command = module.container_command(options, ipc, "studio-test-" + os.urandom(8).hex(), 64001, env)
    probe = r'''import json,os,pathlib,socket,subprocess,sys
receipt=sys.stdout
from worker_relay import SocketRelay
home=pathlib.Path(sys.argv[1]); foreign=pathlib.Path(sys.argv[2]); results={}
def denied(name, fn):
 try: fn(); results[name]=False
 except OSError: results[name]=True
(home/"workspace/output.txt").write_text("own")
results["own"]=(home/"workspace/output.txt").read_text()=="own"
for name in ("config.yaml",".env","SOUL.md","plugins","skills"):
 p=home/name
 denied("replace_"+name,lambda p=p:p.rename(home/(p.name+".old")))
 denied("write_"+name,lambda p=p:(p/"x").write_text("bad") if p.is_dir() else p.write_text("bad"))
denied("foreign",lambda:foreign.read_text())
denied("symlink",lambda:(home/"foreign-link").read_text())
denied("docker",lambda:pathlib.Path("/var/run/docker.sock").read_bytes())
denied("external",lambda:socket.create_connection(("192.0.2.1",443),timeout=1))
denied("host_port",lambda:socket.create_connection(("127.0.0.1",int(sys.argv[3])),timeout=1))
child=subprocess.run([sys.executable,"-c","import pathlib,sys;pathlib.Path(sys.argv[1]).read_text()",str(foreign)],capture_output=True)
results["child"]=child.returncode!=0
try: results["proc"]=b"FOREIGN_DATA_CANARY" not in pathlib.Path("/proc",sys.argv[4],"environ").read_bytes()
except OSError: results["proc"]=True
import run_agent,tui_gateway.server,openai,httpx,sqlite3,ssl
results["imports"]=True
pdf=subprocess.run(["/usr/bin/pdftotext",str(home/"source.pdf"),"-"],capture_output=True,text=True)
results["pdf"]=pdf.returncode==0 and "EMPLOYEE_PDF_CANARY" in pdf.stdout
tcp=socket.socket();tcp.bind(("127.0.0.1",64000));tcp.listen(2)
relay=SocketRelay(tcp,"/run/studio-broker.sock");relay.start()
with socket.create_connection(("127.0.0.1",64000),timeout=10) as stream:
 stream.sendall(b"SCOPED_REQUEST")
 results["first"]=stream.recv(5)==b"first"
 print("FIRST_DELTA",file=receipt,flush=True)
 results["second"]=stream.recv(6)==b"second"
relay.close()
print(json.dumps(results),file=receipt,flush=True)
'''
    command = [*docker.command, *command[:command.index(image) + 1], "-c", probe, str(home), str(foreign),
               str(foreign_tcp.getsockname()[1]), str(victim.pid)]
    process = subprocess.Popen(command, env={**os.environ, **env}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert first.wait(20), "容器未能连接到限定的模型代理通道"
        first_line = process.stdout.readline().strip()
        if first_line != "FIRST_DELTA":
            release.set()
            stdout, stderr = process.communicate(timeout=10)
            pytest.fail(f"容器未返回首段：退出码={process.returncode}，stdout={first_line + stdout!r}，stderr={stderr}")
        release.set()
        stdout, stderr = process.communicate(timeout=30)
        assert process.returncode == 0, stderr
        result = json.loads(stdout.strip().splitlines()[-1])
        assert all(result.values()), result
        assert foreign.read_text() == "FOREIGN_DATA_CANARY"
    finally:
        release.set(); broker.close(); foreign_tcp.close(); server.join(2)
        victim.terminate(); victim.wait(timeout=5)
        if process.poll() is None:
            process.terminate(); process.wait(timeout=5)
        subprocess.run([*docker.command, "rm", "-f", command[command.index("--name") + 1]], capture_output=True, timeout=5)
        temporary.cleanup()


@pytest.mark.platforms("linux")
def test_real_runtime_websocket_preserves_loopback_gate_and_scoped_auth(tmp_path):
    import httpx
    from websockets.asyncio.client import unix_connect
    from websockets.exceptions import InvalidStatus
    from hermes_platform.resolver import locate_command

    image = os.environ.get("HERMES_TEST_IMAGE")
    if not image:
        pytest.skip("真实 Linux WebSocket 验收需固定员工镜像。")
    source = REPO / "apps/drama-studio/server/profiles.py"
    spec = importlib.util.spec_from_file_location("studio_ws_profiles", source)
    profiles = importlib.util.module_from_spec(spec); spec.loader.exec_module(profiles)
    profile = "studio-" + os.urandom(10).hex()
    inference = {"base_url": "http://127.0.0.1:64000/v1", "token": "fixture-scope-" + "a" * 32,
                 "model": "gpt-6", "models": ["gpt-6"], "api_mode": "chat_completions"}
    home = Path(profiles.provision(profile, inference, workers_root=tmp_path / "workers")["home"])
    for folder in ("runtime", "tmp"):
        (home / folder).mkdir()
    token = "fixture-runtime-" + "b" * 40
    env = {"HOME": str(home), "HERMES_HOME": str(home), "TMPDIR": str(home / "tmp"),
           "PYTHONPATH": os.pathsep.join([str(REPO), *[p for p in sys.path if "site-packages" in p]]),
           "PYTHONDONTWRITEBYTECODE": "1", "HERMES_RUNTIME_DIR": str(home / "runtime"),
           "HERMES_DASHBOARD_SESSION_TOKEN": token, "HERMES_SERVE_HEADLESS": "1", "PATH": "/usr/bin:/bin"}
    docker = locate_command("docker"); assert docker.found
    module = _module()
    with tempfile.TemporaryDirectory(prefix="studio-ws-") as directory, tempfile.TemporaryFile(mode="w+") as logs:
        ipc = Path(directory)
        broker = socket.socket(socket.AF_UNIX); broker.bind(str(ipc / "broker.sock")); broker.listen(1)
        options = {"repoRoot": str(REPO), "home": str(home), "python": sys.executable,
                   "pythonPaths": list({sys.prefix, sys.base_prefix}), "linuxWorkerImage": image,
                   "brokerSocket": str(ipc / "broker.sock"), "brokerPort": 64000}
        name = "studio-ws-test-" + os.urandom(8).hex()
        command = [*docker.command, *module.container_command(options, ipc, name, 64001, env)]
        process = subprocess.Popen(command, env={**os.environ, **env}, stdout=logs, stderr=logs)
        async def verify():
            endpoint = str(ipc / "backend.sock")
            async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=endpoint)) as client:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    try:
                        response = await client.get("http://localhost/", headers={"X-Hermes-Session-Token": token}, timeout=2)
                        if response.status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    if process.poll() is not None:
                        logs.seek(0); pytest.fail("隔离运行时提前退出：" + logs.read())
                    await asyncio.sleep(0.1)
                else:
                    logs.seek(0); pytest.fail("隔离运行时未能就绪：" + logs.read())
            with pytest.raises(InvalidStatus):
                async with unix_connect(endpoint, uri="ws://localhost/api/ws?token=wrong", open_timeout=5):
                    pass
            async with unix_connect(endpoint, uri="ws://localhost/api/ws?token=" + token, open_timeout=10) as ws:
                for identifier, method in enumerate(("model.options", "session.list"), 1):
                    params = {"profile": "default"}
                    if method == "model.options":
                        params.update(explicit_only=True, include_unconfigured=False)
                    await ws.send(json.dumps({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}))
                    while True:
                        result = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                        if result.get("id") == identifier:
                            assert "error" not in result and "result" in result, result
                            break
            broker.setblocking(False)
            with pytest.raises(BlockingIOError):
                broker.accept()
        try:
            asyncio.run(verify())
        finally:
            subprocess.run([*docker.command, "rm", "-f", name], capture_output=True, timeout=5)
            process.wait(timeout=5); broker.close()
