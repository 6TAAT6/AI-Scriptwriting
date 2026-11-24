"""要求清单的约束结构必须支持真实落库，不能被受约束生成折叠成空对象。"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest

import jsonschema

ROOT = Path(os.environ.get('APIB_TEST_SOURCE', Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(ROOT))
package = types.ModuleType('requirement_schema_tests')
package.__path__ = [str(ROOT / 'extensions/jubao-drama')]
sys.modules[package.__name__] = package
ledger = importlib.import_module(package.__name__ + '.ledger')


class RequirementSchemaTests(unittest.TestCase):
    def validate(self, constraint):
        jsonschema.validate({'operations': [{'op': 'add', 'quote': '原话', 'constraint': constraint}]}, ledger._SCHEMA)

    def test_known_contracts_and_null_remain_valid(self):
        for value in [None,
            {'kind': 'min_words', 'minimum': 200, 'maximum': None, 'target': 'novel', 'unit': 'document', 'metric': 'non_whitespace_characters'},
            {'kind': 'episode_range', 'episodes': [4, 6]},
            {'kind': 'series_length', 'total': 30},
            {'kind': 'output_kind', 'output_kind': 'outline'},
            {'kind': 'prose_style', 'rule': 'no_novelistic'},
            {'kind': 'edit_range', 'episodes': [3, 3], 'scenes': ['3-2'], 'part': 'ending'}]:
            with self.subTest(value=value):
                self.validate(value)
                if value is not None:
                    self.assertIsNotNone(ledger.clean_constraint(value))

    def test_empty_or_unknown_contracts_are_rejected(self):
        for value in [{}, {'kind': 'arbitrary'}, {'kind': 'min_words', 'minimum': '200'},
            {'kind': 'min_words', 'minimum': 200, 'unexpected': '业务数据'},
            {'kind': 'episode_range', 'episodes': [4, 6, 8]}]:
            with self.subTest(value=value):
                with self.assertRaises(jsonschema.ValidationError):
                    self.validate(value)

    def test_short_novel_limit_persists_without_deterministic_fallback(self):
        with tempfile.TemporaryDirectory(prefix='requirement-schema-') as home:
            previous = os.environ.get('HERMES_HOME')
            os.environ['HERMES_HOME'] = home
            try:
                self.assertEqual(ledger.hermes_home_key(), home)
                text = '主角名保留林溪。短篇小说全文不少于200字。'
                parsed = {'operations': [
                    {'op': 'add', 'quote': '主角名保留林溪', 'text': '保留主角名林溪', 'category': 'character', 'constraint': None},
                    {'op': 'add', 'quote': '短篇小说全文不少于200字', 'text': '短篇小说全文不少于200字', 'category': 'length',
                     'constraint': {'kind': 'min_words', 'minimum': 200, 'maximum': None, 'target': 'novel', 'unit': 'document'}}]}
                jsonschema.validate(parsed, ledger._SCHEMA)
                applied = ledger.apply_extraction('qa', '', 'turn-1', text, parsed)
                self.assertFalse(applied['rejected'])
                rows = ledger.list_requirements('qa')
                self.assertTrue(any('林溪' in row['text'] for row in rows))
                constraint = next(row['constraint'] for row in rows if row['constraint'])
                self.assertEqual((constraint['minimum'], constraint['unit'], constraint['target']), (200, 'document', 'novel'))
            finally:
                if previous is None:
                    os.environ.pop('HERMES_HOME', None)
                else:
                    os.environ['HERMES_HOME'] = previous


if __name__ == '__main__':
    unittest.main()
