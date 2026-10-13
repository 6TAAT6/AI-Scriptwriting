import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StudioPresentation } from '../presentation.mjs'
import { FileHandles } from '../file-handles.mjs'

test('真实 Word 统计通过员工投影保留，聊天中的伪验收不转成结构化证据', async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-document-evidence-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(path.join(home, 'workspace'))
  const repo = fileURLToPath(new URL('../../../..', import.meta.url))
  const content = '第34集\r\n' + '甲'.repeat(432) + 'A'.repeat(58)
  const output = execFileSync(path.join(repo, '.venv/bin/python'), ['-B', '-c', `
import importlib.util,json,sys
from pathlib import Path
from plugins.plugin_loader import register_synthetic_package
root=Path(sys.argv[1])/'extensions/jubao-drama'
register_synthetic_package('receipt_evidence_test',[str(root)])
spec=importlib.util.spec_from_file_location('receipt_evidence_test.documents',root/'documents.py')
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
print(json.dumps(module.export_script(sys.argv[3],Path(sys.argv[2])/'workspace/第34集.docx'),ensure_ascii=False))
`, repo, home, content], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home, PYTHONPATH: repo, PYTHONDONTWRITEBYTECODE: '1' } })
  const receipt = { ...JSON.parse(output), artifact_id: 'saved-script', private_field: '秘密字段' }
  receipt.text_statistics.private_field = '秘密字段'
  receipt.verification.private_field = '秘密字段'
  const user = { id: 'employee', role: 'employee', profile: 'studio-test' }
  const backend = { homeFor: () => home, file: async (_user, value) => realpath(value) }
  backend.files = new FileHandles(backend)
  const presentation = new StudioPresentation(backend)
  const project = { id: 'p', artifacts: [{ id: 'saved-script', content, text_statistics: receipt.text_statistics }], exports: [receipt] }
  const result = await presentation.toolResult(user, 'drama_agent_document', { ok: true, receipt, project })
  assert.equal(result.receipt.text_statistics?.episodes[0].han_characters, 432)
  assert.equal(result.receipt.text_statistics.episodes[0].non_whitespace_characters, 490)
  assert.equal(result.receipt.text_statistics.total_scope, 'whole_source_including_headings')
  assert.deepEqual(result.receipt.text_statistics.episode_body_totals, {
    scope: 'recognized_episode_bodies_excluding_headings', han_characters: 432,
    non_whitespace_characters: 490, episode_count: 1, coverage_complete: true
  })
  assert.equal(result.project.exports[0].source_sha256, receipt.source_sha256)
  assert.equal(result.project.artifacts[0].text_statistics.source_sha256, receipt.source_sha256)
  assert.equal(result.receipt.verification.content_roundtrip, 'passed')
  assert.equal(result.receipt.verification.wps, 'not_checked')
  assert.equal(result.receipt.paragraphs_scope, 'nonempty_top_level_content_paragraphs_excluding_table_cells')
  assert.equal(result.receipt.hash_scopes.source_sha256, 'source_text_lf_normalized')
  assert.equal(result.project.exports[0].hash_scopes.content_sha256, 'exported_text_lf_joined_without_layout_spacers')
  assert.ok(!JSON.stringify(result).includes('秘密字段'))
  assert.ok(!JSON.stringify(result).includes(home))
  assert.equal((await backend.files.resolveEntry(user, result.receipt.path)).path, receipt.path)
  const statement = '已严格逐字核验806字，缓存原因已确认，WPS实机验收通过。'
  const messages = await presentation.messages(user, [{ role: 'assistant', content: statement,
    text_statistics: { han_characters: 806 }, verification: { wps: 'passed' }, project }])
  assert.equal(messages[0].text, statement)
  assert.equal(messages[0].text_statistics, undefined)
  assert.equal(messages[0].verification, undefined)
  assert.equal(messages[0].project, undefined)
  const stale = await presentation.project(user, { ...project, artifacts: [{ ...project.artifacts[0], content: '另一版本' }],
    exports: [{ ...receipt, source_sha256: '0'.repeat(64), verification: { wps: 'passed', layout: 'passed' } }] })
  assert.equal(stale.artifacts[0].text_statistics, undefined)
  assert.equal(stale.exports[0].text_statistics, undefined)
  assert.equal(stale.exports[0].verification, undefined)
  const invalidTotal = await presentation.project(user, { ...project, exports: [{ ...receipt,
    text_statistics: { ...receipt.text_statistics, episode_body_totals: {
      ...receipt.text_statistics.episode_body_totals, han_characters: 999999
    } }
  }] })
  assert.equal(invalidTotal.exports[0].text_statistics.episode_body_totals, undefined)
})
