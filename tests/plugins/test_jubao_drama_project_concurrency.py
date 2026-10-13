"""一个账号的十个剧本并行写入时，标题、原稿和核心期待保持项目隔离。"""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
import threading


def test_ten_projects_write_independently_in_one_account(tmp_path, monkeypatch):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override

    home = tmp_path / 'account'
    home.mkdir()
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(home))
    source = Path(__file__).resolve().parents[2] / 'extensions/jubao-drama/workflow.py'
    spec = importlib.util.spec_from_file_location('drama_parallel_projects', source)
    workflow = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(workflow)
    ready = threading.Barrier(10, timeout=10)

    def write_project(index):
        token = set_hermes_home_override(home)
        try:
            ready.wait()
            store = workflow.ProjectStore()
            project = store.create(f'并行剧本 {index}', source={'content': f'剧本 {index} 的专属原稿。'})
            store.submit(project['id'], 'core', {'content': f'剧本 {index} 的专属核心期待。'}, f'writer-{index}')
            return index, project['id']
        finally:
            reset_hermes_home_override(token)

    with ThreadPoolExecutor(max_workers=10) as pool:
        saved = list(pool.map(write_project, range(10)))
    assert len({project_id for _, project_id in saved}) == 10
    token = set_hermes_home_override(home)
    try:
        store = workflow.ProjectStore()
        for index, project_id in saved:
            project = store.get(project_id)
            assert project['title'] == f'并行剧本 {index}'
            assert project['source']['content'] == f'剧本 {index} 的专属原稿。'
            assert project['core']['content'] == f'剧本 {index} 的专属核心期待。'
    finally:
        reset_hermes_home_override(token)
