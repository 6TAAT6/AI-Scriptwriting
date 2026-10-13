"""用真实 macOS 沙箱验证员工进程边界，不接触运行账号和真实密钥。"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading

import pytest

REPO = Path(__file__).resolve().parents[3]


def _module():
    location = REPO / "apps/drama-studio/server/seatbelt.py"
    spec = importlib.util.spec_from_file_location("studio_seatbelt", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _env(home):
    return {"PATH": "/usr/bin:/bin", "HOME": str(home), "TMPDIR": str(home / "tmp"),
            "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1", "HERMES_HOME": str(home),
            "HERMES_RUNTIME_DIR": str(home / "runtime")}


def _command(tmp_path, employee, broker_port=64000, backend_port=64001, pdf_binary=None):
    employee.mkdir(parents=True, exist_ok=True)
    (employee / "tmp").mkdir(exist_ok=True)
    profile = _module().build_profile(
        repo_root=REPO, python_paths=[sys.prefix, sys.base_prefix], employee_home=employee,
        broker_port=broker_port, backend_port=backend_port, pdf_binary=pdf_binary)
    policy = tmp_path / "worker.sb"
    policy.write_text(profile)
    return ["/usr/bin/sandbox-exec", "-f", str(policy), sys.executable, "-I"]


def _pdf():
    stream = b"BT /F1 12 Tf 30 100 Td (EMPLOYEE_PDF_CANARY) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
    data = b"%PDF-1.4\n"; offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data)); data += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    start = len(data); data += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    data += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    return data + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()


@pytest.mark.platforms("macos")
def test_worker_files_process_tree_and_foreign_process_environment_are_isolated(tmp_path):
    employee = tmp_path / "workers/a"
    command = _command(tmp_path, employee)
    (employee / "config.yaml").write_text("model: {provider: custom, default: fake-test-only}\n")
    (employee / ".env").write_text("CANARY_SCOPE_TOKEN=fake-local-only\n")
    (employee / "SOUL.md").write_text("测试身份")
    for name in ("plugins", "skills", "workspace", "attachments", "logs", "cache"):
        (employee / name).mkdir()
    (employee / "plugins/trusted.py").write_text("trusted = True\n")
    (employee / "skills/trusted.md").write_text("测试规则")
    secret = tmp_path / "workers/b/.env"; secret.parent.mkdir(parents=True); secret.write_text("FAKE_FILE_SECRET")
    (employee / "escape-link").symlink_to(secret)
    canary_env = {**_env(employee), "CANARY_SECRET": "FAKE_PROCESS_SECRET"}
    victim = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(30)"], env=canary_env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    probe = employee / "probe.py"
    probe.write_text('''import ctypes,json,os,pathlib,subprocess,sys
home=pathlib.Path(sys.argv[1]); secret=sys.argv[2]; pid=int(sys.argv[3]); repo=sys.argv[4]
results={}
def attempt(name, fn):
 try: fn(); results[name]="allowed"
 except OSError as e: results[name]=e.errno
attempt("own_write",lambda:(home/"own.txt").write_text("ok"))
attempt("own_read",lambda:(home/"own.txt").read_text())
for folder in ("workspace","attachments","logs","cache"):
 attempt("data_"+folder,lambda name=folder:(home/name/"item.txt").write_text("ok"))
attempt("data_state",lambda:(home/"state.db").write_bytes(b"canary"))
for name in ("config.yaml",".env","SOUL.md","plugins/trusted.py","skills/trusted.md"):
 target=home/name
 attempt("trusted_write_"+name,lambda p=target:p.write_text("bad"))
 attempt("trusted_chmod_"+name,lambda p=target:p.chmod(0o777))
 attempt("trusted_unlink_"+name,lambda p=target:p.unlink())
 attempt("trusted_rename_"+name,lambda p=target:p.rename(home/(p.name+".moved")))
 attempt("trusted_hardlink_"+name,lambda p=target:os.link(p,home/"workspace"/(p.name+".alias")))
 replacement=home/"workspace"/(target.name+".link")
 replacement.unlink(missing_ok=True)
 replacement.symlink_to(home/"own.txt")
 attempt("trusted_symlink_replace_"+name,lambda p=target,q=replacement:os.replace(q,p))
for name in ("plugins","skills"):
 attempt("trusted_directory_rename_"+name,lambda n=name:(home/n).rename(home/(n+".moved")))
 attempt("trusted_directory_unlink_"+name,lambda n=name:(home/n).rmdir())
 replacement=home/"workspace"/(name+".link");replacement.unlink(missing_ok=True);replacement.symlink_to(home/"workspace",target_is_directory=True)
 attempt("trusted_directory_symlink_replace_"+name,lambda n=name,q=replacement:os.replace(q,home/n))
attempt("foreign_read",lambda:pathlib.Path(secret).read_text())
attempt("foreign_write",lambda:pathlib.Path(secret).write_text("bad"))
attempt("foreign_list",lambda:list(pathlib.Path(secret).parent.iterdir()))
attempt("symlink",lambda:(home/"escape-link").read_text())
attempt("hardlink",lambda:os.link(secret,home/"hardlink"))
attempt("shell",lambda:subprocess.run(["/bin/sh","-c","true"],check=True))
attempt("sandbox_reexec",lambda:subprocess.run(["/usr/bin/sandbox-exec","-p","(version 1)(allow default)","/bin/echo","bad"],check=True))
child=subprocess.run([sys.executable,"-I","-c","import pathlib,sys; pathlib.Path(sys.argv[1]).read_text()",secret],capture_output=True,text=True)
results["child_denied"]=child.returncode != 0 and "PermissionError" in child.stderr
libc=ctypes.CDLL(None,use_errno=True); mib=(ctypes.c_int*3)(1,49,pid); size=ctypes.c_size_t(1000000); buf=ctypes.create_string_buffer(size.value)
results["foreign_env_return"]=libc.sysctl(mib,3,buf,ctypes.byref(size),None,0)
results["foreign_env_errno"]=ctypes.get_errno();results["foreign_env_visible"]=b"FAKE_PROCESS_SECRET" in buf.raw
sys.path.insert(0,repo)
import run_agent,tui_gateway.server,openai,httpx,ssl,sqlite3
from providers import get_provider_profile
from hermes_cli.inventory import ConfigContext
from hermes_cli.runtime_provider import canonical_custom_identity
results["provider_registry"]=get_provider_profile("custom") is not None
results["model_context"]=ConfigContext("custom","fake-test-only","http://127.0.0.1:64000/v1",{},[]).current_model
results["catalog_read"]=bool((pathlib.Path(repo)/"plugin-catalog/removed.yaml").read_text())
results["imports"]=True
print(json.dumps(results),flush=True)
''')
    try:
        results = []
        # PM 用基础解释器加 PYTHONPATH，不经过 editable 安装器；两条真实导入路径都必须可用。
        for launcher, extra_env in (
            (command, {}),
            (command[:-2] + [sys._base_executable, "-S"], {"PYTHONPATH": os.pathsep.join(
                [str(REPO), *[value for value in sys.path if "site-packages" in value]])}),
        ):
            result = subprocess.run(launcher + [str(probe), str(employee), str(secret), str(victim.pid), str(REPO)],
                                    cwd=employee, env={**_env(employee), **extra_env}, text=True,
                                    capture_output=True, timeout=20)
            assert result.returncode == 0, result.stderr
            results.append(json.loads((result.stdout + result.stderr).strip().splitlines()[-1]))
    finally:
        victim.terminate(); victim.wait(timeout=5)
    for data in results:
        assert data["own_read"] == data["own_write"] == "allowed"
        assert all(value == "allowed" for name, value in data.items() if name.startswith("data_"))
        assert all(value == 1 for name, value in data.items() if name.startswith("trusted_")), data
        for name in ("foreign_read", "foreign_write", "foreign_list", "symlink", "hardlink", "shell", "sandbox_reexec"):
            assert data[name] == 1, (name, data)
        assert data["child_denied"] and data["imports"]
        assert data["foreign_env_return"] == -1 and data["foreign_env_errno"] == 1
        assert not data["foreign_env_visible"]
        assert data["provider_registry"] and data["catalog_read"]
        assert data["model_context"] == "fake-test-only"
    assert secret.read_text() == "FAKE_FILE_SECRET"
    assert (employee / "config.yaml").read_text() == "model: {provider: custom, default: fake-test-only}\n"
    assert (employee / ".env").read_text() == "CANARY_SCOPE_TOKEN=fake-local-only\n"
    assert (employee / "plugins/trusted.py").read_text() == "trusted = True\n"


@pytest.mark.platforms("macos")
def test_fixed_broker_inherited_listener_and_installed_pdf_conversion_work(tmp_path):
    from hermes_platform.resolver import locate_command
    from hermes_platform.resolver.known_dirs import homebrew_dirs
    pdf = locate_command("pdftotext", known_dirs=homebrew_dirs())
    assert pdf.found, "此验收需要已安装的 pdftotext，不自动安装。"
    employee = tmp_path / "worker"; employee.mkdir(); (employee / "source.pdf").write_bytes(_pdf())
    broker = socket.socket(); broker.bind(("127.0.0.1", 0)); broker.listen(4); broker.settimeout(10)
    forbidden = socket.socket(); forbidden.bind(("127.0.0.1", 0)); forbidden.listen(4)
    listener = socket.socket(); listener.bind(("127.0.0.1", 0)); listener.listen(4)
    def answer():
        connection, _ = broker.accept()
        with connection: connection.recv(32); connection.sendall(b"BROKER_OK")
    thread = threading.Thread(target=answer, daemon=True); thread.start()
    command = _command(tmp_path, employee, broker.getsockname()[1], listener.getsockname()[1], pdf.command[0])
    probe = employee / "network.py"
    probe.write_text('''import json,socket,subprocess,sys,pathlib
home=pathlib.Path(sys.argv[1]); broker=int(sys.argv[2]); forbidden=int(sys.argv[3]); fd=int(sys.argv[4]); pdf=sys.argv[5]; result={}
with socket.create_connection(("127.0.0.1",broker),timeout=3) as s:s.sendall(b"canary");result["broker"]=s.recv(32).decode()
for name,host,port in [("other_port","127.0.0.1",forbidden),("external","192.0.2.1",443)]:
 try:
  with socket.create_connection((host,port),timeout=2):result[name]="allowed"
 except OSError as e:result[name]=e.errno
for host in ("127.0.0.1","0.0.0.0"):
 try:
  with socket.socket() as s:s.bind((host,0));result["bind_"+host]="allowed"
 except OSError as e:result["bind_"+host]=e.errno
converted=subprocess.run([pdf,"-enc","UTF-8","-layout","-","-"],input=(home/"source.pdf").read_bytes(),capture_output=True,timeout=10)
result["pdf_code"]=converted.returncode; result["pdf"]=converted.stdout.decode();result["pdf_error"]=converted.stderr.decode()
print(json.dumps({"ready":True,"result":result}),flush=True)
with socket.socket(fileno=fd) as server:
 server.settimeout(5);conn,_=server.accept()
 with conn:conn.recv(32);conn.sendall(b"WORKER_OK")
''')
    process = subprocess.Popen(command + [str(probe), str(employee), str(broker.getsockname()[1]),
        str(forbidden.getsockname()[1]), str(listener.fileno()), pdf.command[0]], cwd=employee,
        env=_env(employee), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        pass_fds=(listener.fileno(),), close_fds=True)
    try:
        first = process.stdout.readline()
        assert first, (process.wait(timeout=5), process.stderr.read())
        data = json.loads(first)["result"]
        with socket.create_connection(listener.getsockname(), timeout=3) as client:
            client.sendall(b"canary"); assert client.recv(32) == b"WORKER_OK"
        _, error = process.communicate(timeout=5)
        assert process.returncode == 0, error
    finally:
        if process.poll() is None: process.kill(); process.wait(timeout=5)
        broker.close(); forbidden.close(); listener.close(); thread.join(timeout=2)
    assert data["broker"] == "BROKER_OK"
    assert all(data[key] == 1 for key in ("other_port", "external", "bind_127.0.0.1", "bind_0.0.0.0"))
    assert data["pdf_code"] == 0, data["pdf_error"]
    assert "EMPLOYEE_PDF_CANARY" in data["pdf"]
