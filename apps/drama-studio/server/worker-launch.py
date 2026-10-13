"""在进入进程隔离前预绑定回环端口，隔离内禁止自行监听网络。"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile


def main():
    options = json.loads(sys.stdin.read())
    from hermes_platform.host.facts import os_family
    from hermes_platform.resolver import locate_command
    from profiles import sync_worker_capabilities

    host = os_family()
    if host not in {"darwin", "linux"}:
        raise RuntimeError("此主机尚未配置员工进程隔离，拒绝启动。")
    home = Path(options["home"])
    sync_worker_capabilities(home)
    home = home.resolve()
    repo = Path(options["repoRoot"]).resolve()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    runtime = home / "runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    temporary = home / "tmp"
    temporary.mkdir(mode=0o700, exist_ok=True)
    env = {
        "HOME": str(home), "HERMES_HOME": str(home), "TMPDIR": str(temporary),
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin" if host == "darwin" else "/usr/bin:/bin",
        "LANG": "zh_CN.UTF-8" if host == "darwin" else "C.UTF-8", "TZ": "Asia/Shanghai",
        "PYTHONPATH": options["pythonPath"], "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1", "HERMES_SERVE_HEADLESS": "1",
        "HERMES_DASHBOARD_SESSION_TOKEN": options["token"],
        "NO_PROXY": "127.0.0.1,localhost", "HERMES_RUNTIME_DIR": str(runtime),
    }
    if host == "linux":
        from linux_worker import launch
        sys.exit(launch(options, listener, env))
    from seatbelt import build_profile
    pdf = locate_command("pdftotext")
    profile = build_profile(
        repo_root=repo, python_paths=options["pythonPaths"], employee_home=home,
        broker_port=options["brokerPort"], backend_port=port, pdf_binary=pdf.command[0] if pdf.found else None,
    )
    # 隔离策略由父进程保存于员工无法读写的临时目录，不能放在员工运行目录中。
    with tempfile.TemporaryDirectory(prefix="studio-policy-") as policy_root:
        profile_file = Path(policy_root) / "sandbox.sb"
        with profile_file.open("x") as handle:
            handle.write(profile)
        profile_file.chmod(0o600)
        command = ["/usr/bin/sandbox-exec", "-f", str(profile_file), sys.executable,
                   str(repo / "apps/drama-studio/server/runtime.py"), "--worker-fd", str(listener.fileno()), "--port", str(port)]
        child = subprocess.Popen(command, env=env, cwd=home / "workspace", pass_fds=(listener.fileno(),),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=sys.stderr)
        listener.close()
        print(json.dumps({"port": port, "pid": child.pid}), flush=True)
        import signal
        signal.signal(signal.SIGTERM, lambda *_: child.terminate())
        signal.signal(signal.SIGINT, lambda *_: child.terminate())
        result = child.wait()
    sys.exit(result)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("员工创作进程未能在隔离环境启动。", file=sys.stderr)
        sys.exit(1)
