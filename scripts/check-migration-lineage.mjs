#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(root, 'supabase', 'migrations')
const predecessorPath = join(root, 'release', 'production-migration-lineage.json')

const expected = {
  candidateCount: 637,
  predecessorCount: 548,
  upgradeCount: 89,
  firstUpgrade: '20260801204551',
  latestCandidate: '20260815130600',
  upstreamCollision: '20260813120000',
}

function fail(message) {
  console.error(`migration-lineage: ${message}`)
  process.exit(1)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseFilename(filename) {
  const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(filename)
  if (!match) fail(`invalid migration filename: ${filename}`)
  return { filename, version: match[1] }
}

const filenames = (await readdir(migrationsDir))
  .filter((filename) => filename.endsWith('.sql'))
  .sort()

const candidate = await Promise.all(
  filenames.map(async (filename) => ({
    ...parseFilename(filename),
    sha256: sha256(await readFile(join(migrationsDir, filename))),
  })),
)

const versions = new Set()
for (const entry of candidate) {
  if (versions.has(entry.version)) fail(`duplicate migration version: ${entry.version}`)
  versions.add(entry.version)
}

const predecessor = JSON.parse(await readFile(predecessorPath, 'utf8'))
if (predecessor.count !== expected.predecessorCount) {
  fail(`expected ${expected.predecessorCount} predecessor migrations, found ${predecessor.count}`)
}
if (!Array.isArray(predecessor.entries) || predecessor.entries.length !== predecessor.count) {
  fail('predecessor manifest count does not match its entries')
}

const candidateByVersion = new Map(candidate.map((entry) => [entry.version, entry]))
const predecessorVersions = new Set()
for (const entry of predecessor.entries) {
  if (predecessorVersions.has(entry.version)) {
    fail(`duplicate predecessor version: ${entry.version}`)
  }
  predecessorVersions.add(entry.version)

  const current = candidateByVersion.get(entry.version)
  if (!current) fail(`production migration is missing: ${entry.filename}`)
  if (current.filename !== entry.filename) {
    fail(`production migration was renamed: ${entry.filename} -> ${current.filename}`)
  }
  if (current.sha256 !== entry.sha256) {
    fail(`production migration bytes changed: ${entry.filename}`)
  }
}

const upgrade = candidate.filter((entry) => !predecessorVersions.has(entry.version))

if (candidate.length !== expected.candidateCount) {
  fail(`expected ${expected.candidateCount} candidate migrations, found ${candidate.length}`)
}
if (upgrade.length !== expected.upgradeCount) {
  fail(`expected ${expected.upgradeCount} upgrade migrations, found ${upgrade.length}`)
}
if (upgrade[0]?.version !== expected.firstUpgrade) {
  fail(`expected first upgrade ${expected.firstUpgrade}, found ${upgrade[0]?.version ?? 'none'}`)
}
if (candidate.at(-1)?.version !== expected.latestCandidate) {
  fail(`expected latest migration ${expected.latestCandidate}, found ${candidate.at(-1)?.version ?? 'none'}`)
}
if (!candidateByVersion.has(expected.upstreamCollision)) {
  fail(`upstream collision migration is missing: ${expected.upstreamCollision}`)
}
if (predecessorVersions.has(expected.upstreamCollision)) {
  fail(`upstream collision migration must not appear in the production predecessor`)
}

const writeListsIndex = process.argv.indexOf('--write-lists')
if (writeListsIndex !== -1) {
  const outputDir = process.argv[writeListsIndex + 1]
  if (!outputDir) fail('--write-lists requires an output directory')

  await mkdir(outputDir, { recursive: true })
  await writeFile(
    join(outputDir, 'predecessor.txt'),
    `${predecessor.entries.map((entry) => `supabase/migrations/${entry.filename}`).join('\n')}\n`,
  )
  await writeFile(
    join(outputDir, 'upgrade.txt'),
    `${upgrade.map((entry) => `supabase/migrations/${entry.filename}`).join('\n')}\n`,
  )
}

console.log(
  JSON.stringify({
    candidate: candidate.length,
    predecessor: predecessor.count,
    upgrade: upgrade.length,
    firstUpgrade: upgrade[0].version,
    latestCandidate: candidate.at(-1).version,
    predecessorManifest: sha256(await readFile(predecessorPath)),
  }),
)
