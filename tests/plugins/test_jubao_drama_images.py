"""图片选择复用原生生图工具，账号与会话的模型及密钥保持隔离。"""
import base64
import hashlib
import importlib.util
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def test_selected_gpt_and_gemini_generate_through_separate_routes_and_profile_scopes(tmp_path, monkeypatch):
    from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from hermes_cli.config import atomic_config_replace
    from gateway.session_context import set_session_vars, clear_session_vars
    spec = importlib.util.spec_from_file_location('studio_test_images', ROOT/'extensions/jubao-drama/images.py')
    images = importlib.util.module_from_spec(spec); spec.loader.exec_module(images)
    picture=io.BytesIO(); Image.new('RGB',(2,2),'blue').save(picture,format='PNG')
    encoded=base64.b64encode(picture.getvalue()).decode(); calls=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append((self.path,self.headers['Authorization'],body))
            result={'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':encoded}}]}}]} if 'generateContent' in self.path else {'data':[{'b64_json':encoded}]}
            data=json.dumps(result).encode(); self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    monkeypatch.setenv('HERMES_HOME',str(tmp_path/'base'))
    for name,model in [('a','gpt-image-2'),('b','gemini-3.1-flash-image')]:
        home=tmp_path/name;home.mkdir()
        atomic_config_replace(home/'config.yaml',{'providers':{'images':{'base_url':f'http://127.0.0.1:{server.server_port}/v1','key_env':'IMAGE_KEY'}},'image_gen':{'openai':{'provider':'images','model':model},'studio_endpoints':{'images':{'model':model,'models':[model]}}}})
        (home/'.env').write_text('IMAGE_KEY='+name+'-fixture-key\n')
    try:
        for name,model in [('a','gpt-image-2'),('b','gemini-3.1-flash-image'),('a','gpt-image-2')]:
            home=tmp_path/name; h=set_hermes_home_override(home);s=set_secret_scope(build_profile_secret_scope(home),profile_home=str(home));context=set_session_vars(ui_session_id='live')
            try:
                result=images.StudioImageProvider().generate('一座山','square')
                assert result['success'] is True,result
                assert result['model']==model
                assert Path(result['image']).is_relative_to(home)
                assert Path(result['image']).read_bytes()==picture.getvalue()
            finally: clear_session_vars(context);reset_secret_scope(s);reset_hermes_home_override(h)
        assert [row[1] for row in calls]==['Bearer a-fixture-key','Bearer b-fixture-key','Bearer a-fixture-key']
        assert calls[0][0]=='/v1/images/generations'
        assert calls[1][0]=='/v1beta/models/gemini-3.1-flash-image:generateContent'
        # 工作账号通过受限代理生图，路由由配置决定，不依赖运行目录名称。
        home=tmp_path/'isolated-account';home.mkdir()
        atomic_config_replace(home/'config.yaml',{'studio_security':{'restricted':True},'providers':{'images':{'base_url':f'http://127.0.0.1:{server.server_port}/v1','key_env':'IMAGE_KEY'}},'image_gen':{'openai':{'provider':'images','model':'gpt-image-2'},'studio_endpoints':{'images':{'models':['gpt-image-2','gemini-3.1-flash-image']}}}})
        (home/'.env').write_text('IMAGE_KEY=worker-fixture-key\n')
        folder=home/'.studio-image-selections';folder.mkdir()
        (folder/(hashlib.sha256(b'gemini-session').hexdigest()+'.json')).write_text(json.dumps({'provider':'images','model':'gemini-3.1-flash-image'}))
        h=set_hermes_home_override(home);s=set_secret_scope(build_profile_secret_scope(home),profile_home=str(home))
        try:
            for sid,model in [('gemini-session','gemini-3.1-flash-image'),('text-session','gpt-image-2'),('gemini-session','gemini-3.1-flash-image')]:
                context=set_session_vars(ui_session_id=sid)
                try:
                    result=images.StudioImageProvider().generate('一座山','square')
                    assert result['success'] is True
                    assert result['model']==model
                    assert calls[-1][0]=='/v1/images/generations'
                    assert calls[-1][1]=='Bearer worker-fixture-key'
                finally:clear_session_vars(context)
        finally:reset_secret_scope(s);reset_hermes_home_override(h)
    finally:server.shutdown();server.server_close();thread.join(5)
