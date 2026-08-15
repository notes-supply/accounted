import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import acorn from 'next/dist/compiled/acorn/acorn.js'

const { parse } = acorn
const serverDir = path.join(process.cwd(), '.next', 'server')
const traceFile = path.join(serverDir, 'middleware.js.nft.json')

function fail(message) {
  console.error(`Compiled MFA regression check failed: ${message}`)
  process.exit(1)
}

function children(node) {
  if (!node || typeof node !== 'object') return []
  return Object.entries(node)
    .filter(([key]) => !['type', 'start', 'end', 'loc'].includes(key))
    .flatMap(([, value]) => Array.isArray(value) ? value : [value])
    .filter(value => value && typeof value === 'object')
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of children(node)) walk(child, visit)
}

function propertyName(node) {
  if (node?.type !== 'MemberExpression') return null
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name
  if (node.computed && node.property?.type === 'Literal') return node.property.value
  return null
}

function memberPath(node, parts) {
  if (parts.length === 1) return node?.type === 'Identifier' && node.name === parts[0]
  return (
    node?.type === 'MemberExpression' &&
    propertyName(node) === parts.at(-1) &&
    memberPath(node.object, parts.slice(0, -1))
  )
}

function literal(node, value) {
  return node?.type === 'Literal' && node.value === value
}

function identifier(node, name) {
  return node?.type === 'Identifier' && node.name === name
}

function comparison(node, variable, operator, value) {
  if (node?.type !== 'BinaryExpression' || node.operator !== operator) return false
  return (
    (identifier(node.left, variable) && literal(node.right, value)) ||
    (literal(node.left, value) && identifier(node.right, variable))
  )
}

function throwsImmediately(node) {
  if (node?.type === 'ThrowStatement') return true
  return node?.type === 'BlockStatement' && node.body.some(statement => statement.type === 'ThrowStatement')
}

function isRuntimePolicyFunction(node) {
  if (node?.type !== 'FunctionDeclaration' || node.body?.type !== 'BlockStatement') return false

  let policyVariable
  let declarationIndex = -1
  for (const [index, statement] of node.body.body.entries()) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const declaration of statement.declarations) {
      if (
        declaration.id?.type === 'Identifier' &&
        memberPath(declaration.init, ['process', 'env', 'REQUIRE_MFA'])
      ) {
        policyVariable = declaration.id.name
        declarationIndex = index
      }
    }
  }
  if (!policyVariable) return false

  const validationIndex = node.body.body.findIndex((statement, index) => {
    if (index <= declarationIndex || statement.type !== 'IfStatement') return false
    if (!throwsImmediately(statement.consequent)) return false
    const test = statement.test
    if (test?.type !== 'LogicalExpression' || test.operator !== '&&') return false
    return (
      comparison(test.left, policyVariable, '!==', 'true') &&
      comparison(test.right, policyVariable, '!==', 'false')
    ) || (
      comparison(test.left, policyVariable, '!==', 'false') &&
      comparison(test.right, policyVariable, '!==', 'true')
    )
  })
  if (validationIndex < 0) return false

  const returnIndex = node.body.body.findIndex((statement, index) =>
    index > validationIndex &&
    statement.type === 'ReturnStatement' &&
    comparison(statement.argument, policyVariable, '===', 'true'),
  )
  if (returnIndex < 0) return false

  const beforeValidation = node.body.body.slice(declarationIndex + 1, validationIndex)
  if (beforeValidation.some(statement => statement.type === 'ReturnStatement')) return false

  let reassigned = false
  for (const statement of node.body.body.slice(declarationIndex + 1, returnIndex + 1)) {
    walk(statement, candidate => {
      if (
        (candidate.type === 'AssignmentExpression' && identifier(candidate.left, policyVariable)) ||
        (candidate.type === 'UpdateExpression' && identifier(candidate.argument, policyVariable))
      ) reassigned = true
    })
  }
  return !reassigned
}

const ASSURANCE = 1
const FACTORS = 2
const ENROLLMENT = 4
const COMPLETE = ASSURANCE | FACTORS | ENROLLMENT

function marker(node) {
  if (node.type === 'CallExpression') {
    const name = propertyName(node.callee)
    if (name === 'getAuthenticatorAssuranceLevel') return ASSURANCE
    if (name === 'listFactors') return FACTORS
  }
  if (node.type === 'Literal' && typeof node.value === 'string' && node.value.includes('/mfa/enroll')) {
    return ENROLLMENT
  }
  if (node.type === 'TemplateElement' && node.value?.raw?.includes('/mfa/enroll')) {
    return ENROLLMENT
  }
  return 0
}

function knownTruth(node) {
  if (node?.type === 'Literal') return Boolean(node.value)
  if (node?.type === 'UnaryExpression' && node.operator === '!') {
    const value = knownTruth(node.argument)
    return value === undefined ? undefined : !value
  }
  return undefined
}

function isNestedScope(node) {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition'].includes(node?.type)
}

function executionPaths(node, paths = [0], root = false) {
  if (!node || typeof node !== 'object') return paths
  if (!root && isNestedScope(node)) return paths

  const marked = paths.map(value => value | marker(node))
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    const tested = executionPaths(node.test, marked)
    const truth = knownTruth(node.test)
    const branches = []
    if (truth !== false) branches.push(...executionPaths(node.consequent, tested))
    if (truth !== true) branches.push(...(node.alternate ? executionPaths(node.alternate, tested) : tested))
    return branches
  }
  if (node.type === 'LogicalExpression') {
    const left = executionPaths(node.left, marked)
    const truth = knownTruth(node.left)
    if (node.operator === '&&') {
      if (truth === false) return left
      const right = executionPaths(node.right, left)
      return truth === true ? right : [...left, ...right]
    }
    if (truth === true) return left
    const right = executionPaths(node.right, left)
    return truth === false ? right : [...left, ...right]
  }
  if (node.type === 'BlockStatement' || node.type === 'Program') {
    let current = marked
    for (const statement of node.body) {
      current = executionPaths(statement, current)
      if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(statement.type)) break
    }
    return current
  }

  let current = marked
  for (const child of children(node)) current = executionPaths(child, current)
  return current
}

function scopeBindings(node, inherited) {
  const bindings = new Map(inherited)
  if (node.type !== 'Program' && node.type !== 'BlockStatement') return bindings
  for (const statement of node.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id?.name) {
      bindings.set(statement.id.name, isRuntimePolicyFunction(statement))
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.id?.type === 'Identifier') bindings.set(declaration.id.name, false)
      }
    } else if (statement.type === 'ClassDeclaration' && statement.id?.name) {
      bindings.set(statement.id.name, false)
    }
  }
  return bindings
}

function countCompleteRuntimeGates(node, inherited = new Map()) {
  if (!node || typeof node !== 'object') return 0
  const bindings = scopeBindings(node, inherited)
  let count = 0

  if (
    node.type === 'IfStatement' &&
    node.test?.type === 'CallExpression' &&
    node.test.callee?.type === 'Identifier' &&
    bindings.get(node.test.callee.name) === true &&
    executionPaths(node.consequent, [0], true).some(value => value === COMPLETE)
  ) count += 1

  for (const child of children(node)) count += countCompleteRuntimeGates(child, bindings)
  return count
}

let trace
try {
  trace = JSON.parse(await readFile(traceFile, 'utf8'))
} catch (error) {
  fail(`cannot read Next middleware trace: ${error.message}`)
}
if (trace?.version !== 1 || !Array.isArray(trace.files)) {
  fail('Next middleware trace has an unsupported shape')
}

const canonicalServerDir = await realpath(serverDir)
let canonicalNodeModulesDir = null
try {
  canonicalNodeModulesDir = await realpath(path.join(process.cwd(), 'node_modules'))
} catch {}

const compiledFiles = []
for (const entry of trace.files.filter(file => file.endsWith('.js'))) {
  const lexicalPath = path.resolve(serverDir, entry)
  if (lexicalPath.startsWith(`${serverDir}${path.sep}`)) {
    const canonicalPath = await realpath(lexicalPath)
    if (!canonicalPath.startsWith(`${canonicalServerDir}${path.sep}`)) {
      fail(`traced JavaScript escapes the server directory: ${entry}`)
    }
    compiledFiles.push(canonicalPath)
  } else if (canonicalNodeModulesDir && lexicalPath.startsWith(`${canonicalNodeModulesDir}${path.sep}`)) {
    const canonicalPath = await realpath(lexicalPath)
    if (!canonicalPath.startsWith(`${canonicalNodeModulesDir}${path.sep}`)) {
      fail(`traced JavaScript escapes node_modules: ${entry}`)
    }
  } else {
    fail(`traced JavaScript escapes the server directory: ${entry}`)
  }
}
if (compiledFiles.length === 0) fail('Next middleware trace contains no local JavaScript')

let completeGates = 0
for (const file of compiledFiles) {
  const source = await readFile(file, 'utf8')
  let ast
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' })
  } catch (error) {
    fail(`cannot parse traced proxy JavaScript ${path.relative(serverDir, file)}: ${error.message}`)
  }
  completeGates += countCompleteRuntimeGates(ast)
}

if (completeGates !== 1) {
  fail(`expected exactly one traced proxy branch with the complete runtime gate, found ${completeGates}`)
}

console.log('Compiled MFA regression check passed: traced proxy branch retains the complete runtime gate')
