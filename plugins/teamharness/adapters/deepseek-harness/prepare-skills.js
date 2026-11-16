import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

function argumentMap(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1])
  return values
}

function requiredArgument(values, name) {
  const value = String(values.get(name) ?? '').trim()
  if (value === '') throw new Error(`missing ${name}`)
  return resolve(value)
}

function adapterRole(value) {
  const role = String(value ?? '').toLowerCase().replaceAll('_', '-').trim()
  if (['team-leader', 'teamleader', 'leader'].includes(role)) return 'leader'
  if (['worker', 'standalone'].includes(role)) return 'worker'
  if (['remote', 'remote-member'].includes(role)) return 'remote-member'
  if (role === 'manager') return 'manager'
  throw new Error(`unsupported TeamHarness role: ${value}`)
}

function skillEntries(manifest) {
  return [...(manifest?.skills?.manager ?? []), ...(manifest?.skills?.agent ?? []), ...(manifest?.skills?.team ?? [])]
}

function sourceUnderPlugin(pluginDir, configuredPath) {
  if (isAbsolute(configuredPath)) throw new Error(`skill path must be relative: ${configuredPath}`)
  const source = resolve(pluginDir, configuredPath)
  const remainder = relative(pluginDir, source)
  if (remainder.startsWith('..') || isAbsolute(remainder)) throw new Error(`skill path escapes plugin directory: ${configuredPath}`)
  return source
}

const values = argumentMap(process.argv.slice(2))
const pluginDir = requiredArgument(values, '--plugin-dir')
const runtimeConfigPath = requiredArgument(values, '--runtime-config')
const outputDir = requiredArgument(values, '--output')
const marker = join(outputDir, '.teamharness-dsh-skill-root')

const manifest = parse(await readFile(join(pluginDir, 'plugin.yaml'), 'utf8'))
const runtimeConfig = parse(await readFile(runtimeConfigPath, 'utf8'))
const role = adapterRole(runtimeConfig?.member?.role)
const selected = skillEntries(manifest).filter(skill => Array.isArray(skill.roles) && skill.roles.includes(role))
if (selected.length === 0) throw new Error(`TeamHarness has no skills for role ${role}`)

let outputExists = false
try {
  outputExists = (await stat(outputDir)).isDirectory()
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
if (outputExists) {
  try {
    await stat(marker)
  } catch {
    throw new Error(`refusing to replace unmarked skill directory: ${outputDir}`)
  }
  await rm(outputDir, { recursive: true, force: true })
}
await mkdir(outputDir, { recursive: true })
await writeFile(marker, 'Generated TeamHarness role skill root for DeepSeek Harness\n', 'utf8')

for (const skill of selected) {
  const source = sourceUnderPlugin(pluginDir, String(skill.path ?? ''))
  await cp(source, join(outputDir, basename(source)), { recursive: true })
}

const warnings = []
const assigned = []
const builtinIds = new Set(selected.map(skill => skill.id))
const workerHome = process.env.AGENTTEAMS_WORKER_HOME || dirname(dirname(runtimeConfigPath))
for (const name of runtimeConfig?.desired?.skills ?? []) {
  if (builtinIds.has(name)) continue
  try {
    if (!/^[a-zA-Z0-9][\w.-]*$/.test(name) || ['.', '..'].includes(name)) throw new Error('invalid skill name')
    const source = sourceUnderPlugin(join(workerHome, 'skills'), name)
    const prefix = process.env.AGENTTEAMS_STORAGE_PREFIX
    const worker = process.env.AGENTTEAMS_WORKER_NAME
    if (prefix && worker) {
      const copied = spawnSync('mc', ['mirror', `${prefix.replace(/\/$/, '')}/agents/${worker}/skills/${name}/`, source, '--overwrite'], { timeout: 15000 })
      if (copied.error || copied.status !== 0) throw new Error('skill sync failed')
    }
    const actual = await realpath(source)
    if (relative(await realpath(join(workerHome, 'skills')), actual).startsWith('..')) throw new Error('skill path escapes workspace')
    for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('skill payload must not contain symbolic links')
    }
    const content = await readFile(join(source, 'SKILL.md'), 'utf8')
    if (!content.trim()) throw new Error('empty SKILL.md')
    if (/^---\r?\n/.test(content)) {
      const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|\s*$)/)
      const metadata = frontmatter && parse(frontmatter[1])
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid frontmatter')
    }
    await cp(source, join(outputDir, name), { recursive: true })
    assigned.push(name)
  } catch (error) {
    const warning = `Skill ${name}: load failed (${error.name})`
    warnings.push(warning)
    process.stderr.write(`Skill assignment warning: ${warning}\n`)
  }
}
const libDir = process.env.AGENTTEAMS_LOG_LIB_DIR || '/opt/agentteams/scripts/lib'
if (existsSync(join(libDir, 'agentteams_skill_warnings.py'))) {
  spawnSync(process.env.TEAMHARNESS_PYTHON || 'python3', ['-c', 'import json,sys; from agentteams_skill_warnings import report_warnings; report_warnings(json.loads(sys.argv[1]))', JSON.stringify(warnings)], {
    env: { ...process.env, PYTHONPATH: `${libDir}:${process.env.PYTHONPATH || ''}` }, timeout: 5000,
  })
}
process.stdout.write(`${JSON.stringify({ role, skills: [...selected.map(skill => skill.id), ...assigned], warnings })}\n`)
