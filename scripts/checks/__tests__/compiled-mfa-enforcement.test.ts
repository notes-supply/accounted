import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const checker = path.resolve('scripts/checks/compiled-mfa-enforcement.mjs')
const workspaces: string[] = []
const policy = 'function gate(){let value=process.env.REQUIRE_MFA;if(value!=="true"&&value!=="false")throw Error();return value==="true"}'
const completeBranch = 'if(gate(user)){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();redirect("/mfa/enroll")}'

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'compiled-mfa-'))
  workspaces.push(root)
  mkdirSync(path.join(root, '.next/server/chunks'), { recursive: true })
  return root
}

function runFixture(source: string) {
  const root = workspace()
  writeFileSync(
    path.join(root, '.next/server/middleware.js.nft.json'),
    JSON.stringify({ version: 1, files: ['./chunks/proxy.js'] }),
  )
  writeFileSync(path.join(root, '.next/server/chunks/proxy.js'), source)
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' })
}

afterEach(() => {
  for (const root of workspaces.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('compiled MFA enforcement guard', () => {
  it('accepts one complete runtime-controlled middleware gate', () => {
    const result = runFixture(`${policy};${completeBranch}`)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('retains the complete runtime gate')
  })

  it('rejects policy marker strings without runtime semantics', () => {
    const result = runFixture(
      'function gate(){"process.env.REQUIRE_MFA";return true};' + completeBranch,
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects a policy that does not validate both boolean spellings', () => {
    const result = runFixture(
      'function gate(){let value=process.env.REQUIRE_MFA;return value==="true"};' + completeBranch,
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects enforcement markers outside the policy-controlled branch', () => {
    const result = runFixture(
      `${policy};if(gate(user)){};auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();redirect("/mfa/enroll")`,
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects markers split across mutually exclusive paths', () => {
    const result = runFixture(
      `${policy};if(gate(user)){if(choice){auth.mfa.getAuthenticatorAssuranceLevel()}else{auth.mfa.listFactors();redirect("/mfa/enroll")}}`,
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects markers hidden in an uncalled nested function', () => {
    const result = runFixture(
      `${policy};if(gate(user)){function unused(){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();redirect("/mfa/enroll")}}`,
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects duplicate complete runtime gates', () => {
    const result = runFixture(`${policy};${completeBranch};${completeBranch}`)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 2')
  })

  it('rejects traced symlinks that escape the server build directory', () => {
    const root = workspace()
    const outside = path.join(root, 'outside.js')
    writeFileSync(
      path.join(root, '.next/server/middleware.js.nft.json'),
      JSON.stringify({ version: 1, files: ['./chunks/proxy.js'] }),
    )
    writeFileSync(outside, `${policy};${completeBranch}`)
    symlinkSync(outside, path.join(root, '.next/server/chunks/proxy.js'))

    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('escapes the server directory')
  })
})
