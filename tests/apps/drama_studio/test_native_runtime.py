"""预装运行环境贯穿后台辅助命令，配置读取绑定真正所属的运营 profile。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[3]


def _config(source, secret):
    source.mkdir(parents=True)
    (source / ".env").write_text(f"STUDIO_MODEL_KEY={secret}\n")
    (source / "config.yaml").write_text(json.dumps({
        "model": {"provider": "native-fixture", "default": "gpt-6", "api_mode": "chat_completions"},
        "providers": {"native-fixture": {"base_url": "https://fixture.invalid/v1", "models": ["gpt-6"], "api_key": "${STUDIO_MODEL_KEY}", "transport": "codex_responses"}},
    }))


def test_preinstalled_interpreter_runs_settings_profiles_and_catalog_without_pm(tmp_path):
    root = tmp_path.resolve()
    home = root / "state"
    _config(home / "profiles/jubao-drama", "native-fixture-secret")
    checkout = ROOT
    runtime = {"python": sys.executable, "pythonPath": str(root / "stale-release"),
               "pythonPaths": [sys.base_prefix, sys.prefix], "runtimeDir": str(root / "tools")}
    script = """
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { WorkerPool } from WORKER_MODULE
import { StudioBackend } from BACKEND_MODULE
const input = JSON.parse(await new Promise(resolve => { let s=''; process.stdin.on('data', c => s+=c); process.stdin.on('end', () => resolve(s)) }))
const pool = new WorkerPool({repoRoot: input.checkout, hermesHome: input.home, nativeRuntime: input.runtime, ipcRoot: input.ipcRoot, linuxWorkerImage: 'sha256:'+'a'.repeat(64)})
try {
  const settings = await pool.readSettings()
  assert.equal(settings.apiKey, 'native-fixture-secret')
  assert.equal(settings.apiMode, 'responses')
  if (process.platform === 'linux') {
    const tooLong = new WorkerPool({repoRoot:input.checkout,hermesHome:input.home,nativeRuntime:input.runtime,ipcRoot:input.ipcRoot+'/'+'剧'.repeat(32),linuxWorkerImage:'sha256:'+'a'.repeat(64),settingsLoader:async()=>({...settings})})
    try { await assert.rejects(tooLong.initialize(), /通信目录过长.*ipcRoot/) }
    finally { await tooLong.close() }
  }
  await pool.initialize()
      assert.equal(pool.runtime.python, input.runtime.python)
      assert.equal(pool.runtime.pythonPath, input.checkout)
      assert.deepEqual(pool.runtime.pythonPaths, input.runtime.pythonPaths)
      assert.equal(pool.runtime.runtimeDir, input.runtime.runtimeDir)
  if (process.platform === 'linux') assert.ok(pool.broker.unixSocket.startsWith(input.ipcRoot+'/'))
  const profile = 'studio-'+'a'.repeat(20)
  const created = await pool.provision(profile)
  assert.equal(created.profile, profile)
  await pool.refreshModels()
  await pool.refresh(profile)
  const stored = await readFile(created.home+'/config.yaml', 'utf8')
  assert.ok(stored.includes('studio-inference'))
  assert.ok(!stored.includes('native-fixture-secret'))
  const backend = new StudioBackend({backend:'http://127.0.0.1:1',repoRoot:input.checkout,hermesHome:input.home,workerPool:pool})
  const response = await backend.presentation.rpc({id:'root',role:'super_admin',profile:'jubao-drama'}, {method:'model.options',params:{}}, {id:1,result:{provider:'native-fixture',model:'gpt-6',providers:[{slug:'native-fixture',models:['gpt-6']}]}})
  assert.ok(response.result.providers[0].capabilities['gpt-6'].supported_efforts.includes('high'))
  process.stdout.write(JSON.stringify({ok:true}))
} finally { await pool.close() }
""".replace("WORKER_MODULE", json.dumps((ROOT / "apps/drama-studio/server/worker-pool.mjs").as_uri())).replace("BACKEND_MODULE", json.dumps((ROOT / "apps/drama-studio/server/backend.mjs").as_uri()))
    # Linux sockaddr_un 限制路径字节数，不能沿用 pytest 的深层工作目录。
    with TemporaryDirectory(prefix="studio-ipc-", dir="/tmp") as ipc:
        result = subprocess.run(["node", "--input-type=module", "-e", script], text=True, capture_output=True,
                                input=json.dumps({"checkout": str(checkout), "home": str(home), "runtime": runtime,
                                                  "ipcRoot": str(Path(ipc).resolve())}), timeout=60)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"ok": True}
    assert "native-fixture-secret" not in result.stdout + result.stderr


def test_settings_resolve_each_profile_secret_and_restore_callers_scope(tmp_path, monkeypatch):
    from agent.secret_scope import build_profile_secret_scope, current_secret_scope_home, is_multiplex_active, reset_secret_scope, set_multiplex_active, set_secret_scope
    from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    launch = tmp_path / "launch"
    _config(launch, "wrong-launch-secret")
    monkeypatch.setenv("HERMES_HOME", str(launch))
    monkeypatch.setenv("STUDIO_MODEL_KEY", "wrong-process-secret")
    homes = [tmp_path / name for name in ("a", "b")]
    for home, value in zip(homes, ("profile-a-secret", "profile-b-secret")):
        _config(home / "profiles/jubao-drama", value)
    spec = importlib.util.spec_from_file_location("studio_native_settings", ROOT / "apps/drama-studio/server/worker-settings.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    was_multiplex = is_multiplex_active()
    set_multiplex_active(True)
    home_token = set_hermes_home_override(launch)
    secret_token = set_secret_scope(build_profile_secret_scope(launch), profile_home=str(launch))
    try:
        for home, expected in ((homes[0], "profile-a-secret"), (homes[1], "profile-b-secret"), (homes[0], "profile-a-secret")):
            assert module.read_settings(home)["apiKey"] == expected
            assert get_hermes_home() == launch
            assert current_secret_scope_home() == str(launch)
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)
        set_multiplex_active(was_multiplex)
