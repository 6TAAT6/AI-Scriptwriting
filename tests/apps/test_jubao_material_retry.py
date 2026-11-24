"""Word 误带工作表参数时给出可执行的同工具纠正调用，保留账号边界。"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

ROOT = Path(os.environ.get('APIB_TEST_SOURCE', Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(ROOT))
location = ROOT / 'extensions/jubao-drama/__init__.py'
spec = importlib.util.spec_from_file_location('material_retry_test', location, submodule_search_locations=[str(location.parent)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)


class MaterialRetryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='material-retry-')
        self.home = Path(self.directory.name)
        self.previous = os.environ.get('HERMES_HOME')
        os.environ['HERMES_HOME'] = str(self.home)
        (self.home / 'config.yaml').write_text('studio_security:\n  restricted: true\n  require_agent_invocation: false\n')
        self.source = self.home / 'attachments/验收原稿.docx'
        self.source.parent.mkdir()
        self.text = '林溪在青石镇找到了父亲留下的信。' * 180
        with ZipFile(self.source, 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + self.text + '</w:t></w:r></w:p></w:body></w:document>')
        self.invoke = plugin._safe_business_result('drama_material_import', plugin._material_handler)

    def tearDown(self):
        if self.previous is None:
            os.environ.pop('HERMES_HOME', None)
        else:
            os.environ['HERMES_HOME'] = self.previous
        self.directory.cleanup()

    def test_word_sheet_error_preserves_file_and_paging_then_reads_actual_text(self):
        args = {'path': str(self.source), 'sheet': 'Sheet1', 'start_char': 1000, 'max_chars': 1000}
        error = json.loads(self.invoke(args, session_id='qa'))
        self.assertFalse(error['ok'])
        self.assertTrue(error['retryable'])
        self.assertIn('next_call', error)
        self.assertEqual(error['next_call'], {key: value for key, value in args.items() if key != 'sheet'})
        restored = json.loads(self.invoke(error['next_call'], session_id='qa'))
        self.assertTrue(restored['ok'])
        self.assertEqual(restored['material']['text'], self.text[1000:2000])
        self.assertEqual(restored['material']['source_start_char'], 1000)
        self.assertEqual(restored['material']['source_end_char'], 2000)
        self.assertEqual(args['sheet'], 'Sheet1')

    def test_account_boundary_and_other_parameter_errors_have_no_repair_shortcut(self):
        for args in [
            {'path': str(self.home.parent / 'foreign.docx'), 'sheet': 'Sheet1'},
            {'path': str(self.source), 'sheet': 'Sheet1', 'max_chars': -1},
            {'path': str(self.source), 'sheet': 'Sheet1', 'cell_range': 'A1'}]:
            with self.subTest(args=args):
                result = json.loads(self.invoke(args, session_id='qa'))
                self.assertFalse(result['ok'])
                self.assertNotIn('next_call', result)


if __name__ == '__main__':
    unittest.main()
