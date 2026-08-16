import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const checker = path.resolve('scripts/checks/compiled-mfa-enforcement.mjs')
const workspaces: string[] = []

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'compiled-mfa-'))
  workspaces.push(root)
  mkdirSync(path.join(root, '.next/server/chunks'), { recursive: true })
  return root
}

function writeTrace(root: string, files: string[]) {
  writeFileSync(
    path.join(root, '.next/server/middleware.js.nft.json'),
    JSON.stringify({ version: 1, files }),
  )
}

function run(root: string) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' })
}

afterEach(() => {
  workspaces.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('compiled MFA enforcement guard', () => {
  it('ignores marker strings in JavaScript outside the traced proxy closure', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(path.join(root, '.next/server/chunks/proxy.js'), 'module.exports = {}')
    mkdirSync(path.join(root, '.next/server/unrelated'), { recursive: true })
    writeFileSync(
      path.join(root, '.next/server/unrelated/not-middleware.js'),
      'process.env.REQUIRE_MFA; "REQUIRE_MFA must be explicitly set to exactly"; "getAuthenticatorAssuranceLevel"; "listFactors"; "/mfa/enroll"',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects markers that are outside an empty policy-controlled branch', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){let value=process.env.REQUIRE_MFA;if(value!=="true"&&value!=="false")throw Error("REQUIRE_MFA must be explicitly set to exactly");return value==="true"} if(gate(user)){} "getAuthenticatorAssuranceLevel"; "listFactors"; "/mfa/enroll"',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects markers that exist only in a statically unreachable nested branch', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){let value=process.env.REQUIRE_MFA;if(value!=="true"&&value!=="false")throw Error();return value==="true"} if(gate(user)){if(false){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();response.redirect("/mfa/enroll")}}',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects markers that exist only inside an uncalled nested function', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){let value=process.env.REQUIRE_MFA;if(value!=="true"&&value!=="false")throw Error();return value==="true"} if(gate(user)){function unrelated(){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();response.redirect("/mfa/enroll")}}',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects a policy helper made from marker strings instead of runtime semantics', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){"process.env.REQUIRE_MFA";"REQUIRE_MFA must be explicitly set to exactly";return "true"} if(gate(user)){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();response.redirect("/mfa/enroll")}',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects traced symlinks that escape the server build directory', () => {
    const root = workspace()
    const outside = path.join(root, 'outside.js')
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(outside, 'module.exports = {}')
    symlinkSync(outside, path.join(root, '.next/server/chunks/proxy.js'))

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('escapes the server directory')
  })

  it('rejects gate markers split across mutually exclusive branches', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){let value=process.env.REQUIRE_MFA;if(value!=="true"&&value!=="false")throw Error();return value==="true"} if(gate(user)){if(choice){auth.mfa.getAuthenticatorAssuranceLevel()}else{auth.mfa.listFactors();response.redirect("/mfa/enroll")}}',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects a policy helper that is not in lexical scope at the call site', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function outer(){function gate(){let value=process.env.REQUIRE_MFA;if(value!=="true"&&value!=="false")throw Error();return value==="true"}} if(gate(user)){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();response.redirect("/mfa/enroll")}',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects policy validation after an unconditional return', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){let value=process.env.REQUIRE_MFA;return value==="true";if(value!=="true"&&value!=="false")throw Error()} if(gate(user)){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();response.redirect("/mfa/enroll")}',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects reassignment of the environment-derived value before validation', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){let value=process.env.REQUIRE_MFA;value="true";if(value!=="true"&&value!=="false")throw Error();return value==="true"} if(gate(user)){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();response.redirect("/mfa/enroll")}',
    )

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('found 0')
  })

  it('rejects any lexical trace escape even when a valid local entry exists', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js', '../outside.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){let value=process.env.REQUIRE_MFA;if(value!=="true"&&value!=="false")throw Error();return value==="true"} if(gate(user)){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();response.redirect("/mfa/enroll")}',
    )
    writeFileSync(path.join(root, '.next/outside.js'), 'module.exports = {}')

    const result = run(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('escapes the server directory')
  })

  it('accepts the runtime policy and enrollment flow only inside a traced proxy chunk', () => {
    const root = workspace()
    writeTrace(root, ['./chunks/proxy.js'])
    writeFileSync(
      path.join(root, '.next/server/chunks/proxy.js'),
      'function gate(){let value=process.env.REQUIRE_MFA;if(value!=="true"&&value!=="false")throw Error("REQUIRE_MFA must be explicitly set to exactly");return value==="true"} if(gate(user)){auth.mfa.getAuthenticatorAssuranceLevel();auth.mfa.listFactors();response.redirect("/mfa/enroll")}',
    )

    const result = run(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('traced proxy branch retains the complete runtime gate')
  })
})
