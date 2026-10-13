import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pythonInvocation } from '../python-runtime.mjs'

test('native runtime always imports code from the active release', () => {
  const root = path.join(path.sep, 'srv', 'jubao-hermes', 'releases', 'r8')
  const invocation = pythonInvocation(root, path.join(root, 'state'), '/tmp/fixture.py', [], {
    python: '/usr/bin/python3',
    pythonPath: path.join(path.sep, 'srv', 'jubao-hermes', 'releases', 'r2'),
    pythonPaths: ['/opt/hermes-runtime'],
    runtimeDir: '/opt/hermes-tools',
  })
  assert.equal(invocation.env.PYTHONPATH, root)
})
