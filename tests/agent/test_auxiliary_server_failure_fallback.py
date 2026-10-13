"""服务端 5xx 重试结束后须继续走显式备用路由，且不得混用账号凭据。"""
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path


def test_http_503_falls_back_with_profile_scoped_credentials(tmp_path,monkeypatch):
    from hermes_cli.config import atomic_config_replace
    from agent.auxiliary_client import call_llm
    from agent.secret_scope import build_profile_secret_scope,set_secret_scope,reset_secret_scope,set_multiplex_active,is_multiplex_active
    from hermes_constants import set_hermes_home_override,reset_hermes_home_override
    received=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            received.append((self.path,self.headers.get('Authorization'),body['model']))
            status=503 if self.path.startswith('/primary/') else 200
            self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers()
            data={'error':{'message':'temporary unavailable'}} if status==503 else {'model':body['model'],'choices':[{'message':{'role':'assistant','content':'压缩摘要正常返回'},'finish_reason':'stop'}]}
            self.wfile.write(json.dumps(data).encode())
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    root=f'http://127.0.0.1:{server.server_port}';monkeypatch.setattr(Path,'home',lambda:tmp_path)
    homes=[]
    for name in ('A','B'):
        home=tmp_path/name;home.mkdir();(home/'.env').write_text('FALLBACK_KEY=account-'+name+'\n')
        atomic_config_replace(home/'config.yaml',{'auxiliary':{'transient_retries':0,'compression':{'provider':'custom','model':'gpt-6-astra','base_url':root+'/primary/'+name+'/v1','api_key':'primary-'+name,'api_mode':'chat_completions','fallback_chain':[{'provider':'custom','model':'gpt-6.1-sol','base_url':root+'/fallback/'+name+'/v1','key_env':'FALLBACK_KEY','api_mode':'chat_completions'}]}}})
        homes.append(home)
    before=is_multiplex_active();set_multiplex_active(True)
    try:
        for home in (homes[0],homes[1],homes[0]):
            monkeypatch.setenv('HERMES_HOME',str(home));h=set_hermes_home_override(home);s=set_secret_scope(build_profile_secret_scope(home),profile_home=str(home))
            try:
                response=call_llm(task='compression',messages=[{'role':'user','content':'保留已确认事实'}],max_tokens=100)
                assert response.choices[0].message.content=='压缩摘要正常返回'
                assert received[-1][0].startswith('/fallback/'+home.name+'/')
                assert received[-1][1]=='Bearer account-'+home.name
            finally:reset_secret_scope(s);reset_hermes_home_override(h)
    finally:
        set_multiplex_active(before);server.shutdown();server.server_close();thread.join()
