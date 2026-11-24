"""新站非流式和结构化请求通过真实 SDK；其他中转保持原请求形状。"""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(os.environ.get('APIB_TEST_SOURCE',Path(__file__).resolve().parents[2]))
sys.path.insert(0,str(ROOT))
import httpx
from openai import OpenAI
from agent.auxiliary_wire import prepare_chat_messages


class ApibAuxiliaryWireTests(unittest.TestCase):
    def request(self,host,request):
        captured=[]
        def respond(req):
            captured.append(json.loads(req.content))
            return httpx.Response(200,json={'id':'test','object':'chat.completion','created':1,'model':'gemini-4-hydrogen','choices':[{'index':0,'message':{'role':'assistant','content':'正常'},'finish_reason':'stop'}]})
        with tempfile.TemporaryDirectory(prefix='apib-sdk-') as home:
            previous=os.environ.get('HERMES_HOME');os.environ['HERMES_HOME']=home
            try:
                with OpenAI(api_key='fixture-only',base_url='https://'+host+'/v1',http_client=httpx.Client(transport=httpx.MockTransport(respond))) as client:
                    shaped=prepare_chat_messages(client,request)
                    client.chat.completions.create(**shaped)
            finally:
                if previous is None:os.environ.pop('HERMES_HOME',None)
                else:os.environ['HERMES_HOME']=previous
        return captured[0]

    def test_explicit_nonstream_and_nullable_schema_reach_sdk(self):
        schema={'type':'object','properties':{'constraint':{'type':['object','null'],'properties':{'minimum':{'type':['integer','null'],'minimum':0}}}},'examples':[{'type':['用户','原文']}]}
        request={'model':'gemini-4-hydrogen','messages':[{'role':'user','content':'提取要求'}],'extra_body':{'response_format':{'type':'json_schema','json_schema':{'schema':schema}}}}
        original=copy.deepcopy(request)
        sent=self.request('api.apib.ai',request)
        self.assertIs(sent.get('stream'),False)
        self.assertEqual(sent['response_format']['json_schema']['schema']['properties']['constraint']['anyOf'],[{'type':'object'},{'type':'null'}])
        self.assertEqual(sent['response_format']['json_schema']['schema']['examples'],schema['examples'])
        self.assertEqual(sent['messages'],request['messages'])
        self.assertEqual(request,original)

    def test_other_hosts_and_models_keep_their_request(self):
        for host,model in [('sub2.xlbby.com','gemini-4-hydrogen'),('api.apib.ai.evil.example','gemini-4-hydrogen'),('api.apib.ai','gpt-6-astra')]:
            request={'model':model,'messages':[{'role':'user','content':'原文'}],'extra_body':{'response_format':{'type':'json_schema','json_schema':{'schema':{'type':['object','null']}}}}}
            sent=self.request(host,request)
            self.assertNotIn('stream',sent)
            self.assertEqual(sent['response_format'],request['extra_body']['response_format'])

    def test_explicit_stream_choice_is_preserved(self):
        with OpenAI(api_key='fixture-only',base_url='https://api.apib.ai/v1') as client:
            for value in [False,True]:
                request={'model':'gemini-4-argon','messages':[{'role':'user','content':'原文'}],'stream':value}
                self.assertIs(prepare_chat_messages(client,request)['stream'],value)
            request={'model':'gemini-4-argon','messages':[{'role':'user','content':'原文'}],'extra_body':{'stream':True}}
            result=prepare_chat_messages(client,request)
            self.assertTrue(result['extra_body']['stream'])
            self.assertNotIn('stream',result)


if __name__=='__main__':unittest.main()
