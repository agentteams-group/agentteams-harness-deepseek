import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('assigned skills reach the native DSH root while malformed and missing skills only warn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-'))
  try {
    const plugin = join(root, 'plugin')
    await mkdir(join(plugin, 'basic'), { recursive: true })
    await mkdir(join(root, 'runtime'))
    await writeFile(join(plugin, 'plugin.yaml'), 'skills:\n  agent:\n    - id: basic\n      path: basic\n      roles: [worker]\n')
    await writeFile(join(plugin, 'basic/SKILL.md'), '# Builtin\n')
    await writeFile(join(root, 'runtime/runtime.yaml'), 'member:\n  role: worker\ndesired:\n  skills: [healthy, broken, missing]\n')
    for (const [name, content] of [['healthy', '# Healthy\n'], ['broken', '---\nname: [broken\n---\n']]) {
      await mkdir(join(root, 'skills', name), { recursive: true })
      await writeFile(join(root, 'skills', name, 'SKILL.md'), content)
    }
    const run = () => spawnSync(process.execPath, [resolve('plugins/teamharness/adapters/deepseek-harness/prepare-skills.js'), '--plugin-dir', plugin, '--runtime-config', join(root, 'runtime/runtime.yaml'), '--output', join(root, 'generated')], {
      encoding: 'utf8', env: { ...process.env, AGENTTEAMS_STORAGE_PREFIX: '', AGENTTEAMS_WORKER_HOME: root },
    })
    let result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).warnings.length, 2)
    assert.equal(await readFile(join(root, 'generated/healthy/SKILL.md'), 'utf8'), '# Healthy\n')
    for (const name of ['broken', 'missing']) {
      await mkdir(join(root, 'skills', name), { recursive: true })
      await writeFile(join(root, 'skills', name, 'SKILL.md'), '# Repaired\n')
    }
    result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).warnings, [])
    assert.equal(await readFile(join(root, 'generated/missing/SKILL.md'), 'utf8'), '# Repaired\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})
