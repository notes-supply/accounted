import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import acorn from 'next/dist/compiled/acorn/acorn.js'

const { parse } = acorn
const serverDir = path.join(process.cwd(), '.next', 'server')
const tracePath = path.join(serverDir, 'middleware.js.nft.json')

function fail(message) {
  console.error(`Compiled MFA regression check failed: ${message}`)
  process.exit(1)
}

function visit(node, visitor) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visitor(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue
    if (Array.isArray(value)) value.forEach((child) => visit(child, visitor))
    else if (value && typeof value === 'object') visit(value, visitor)
  }
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') return null
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name
  if (node.computed && node.property?.type === 'Literal') return node.property.value
  return null
}

function isMemberPath(node, names) {
  if (names.length === 1) return node?.type === 'Identifier' && node.name === names[0]
  return (
    node?.type === 'MemberExpression' &&
    memberName(node) === names[names.length - 1] &&
    isMemberPath(node.object, names.slice(0, -1))
  )
}

function isLiteral(node, value) {
  return node?.type === 'Literal' && node.value === value
}

function isVariable(node, name) {
  return node?.type === 'Identifier' && node.name === name
}

function isComparison(node, variable, operator, value) {
  if (node?.type !== 'BinaryExpression' || node.operator !== operator) return false
  return (
    (isVariable(node.left, variable) && isLiteral(node.right, value)) ||
    (isLiteral(node.left, value) && isVariable(node.right, variable))
  )
}

function containsThrow(node) {
  if (node?.type === 'ThrowStatement') return true
  return node?.type === 'BlockStatement' && node.body.some((statement) => statement.type === 'ThrowStatement')
}

function hasRuntimePolicy(node) {
  if (node.type !== 'FunctionDeclaration' || !node.id?.name || node.body?.type !== 'BlockStatement') {
    return false
  }

  let variable
  let declarationIndex = -1
  for (const [index, statement] of node.body.body.entries()) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const declaration of statement.declarations) {
      if (
        declaration.id?.type === 'Identifier' &&
        isMemberPath(declaration.init, ['process', 'env', 'REQUIRE_MFA'])
      ) {
        variable = declaration.id.name
        declarationIndex = index
      }
    }
  }
  if (!variable) return false

  const rejectionIndex = node.body.body.findIndex((statement, index) => {
    if (index <= declarationIndex) return false
    if (statement.type !== 'IfStatement' || !containsThrow(statement.consequent)) return false
    const test = statement.test
    if (test?.type !== 'LogicalExpression' || test.operator !== '&&') return false
    return (
      (isComparison(test.left, variable, '!==', 'true') &&
        isComparison(test.right, variable, '!==', 'false')) ||
      (isComparison(test.left, variable, '!==', 'false') &&
        isComparison(test.right, variable, '!==', 'true'))
    )
  })

  const returnIndex = node.body.body.findIndex(
    (statement, index) =>
      index > rejectionIndex &&
      statement.type === 'ReturnStatement' &&
      isComparison(statement.argument, variable, '===', 'true'),
  )

  if (rejectionIndex < 0 || returnIndex < 0) return false
  if (node.body.body.slice(declarationIndex + 1, rejectionIndex).some((statement) => statement.type === 'ReturnStatement')) {
    return false
  }

  let reassigned = false
  for (const statement of node.body.body.slice(declarationIndex + 1, returnIndex + 1)) {
    visit(statement, (candidate) => {
      if (
        (candidate.type === 'AssignmentExpression' && isVariable(candidate.left, variable)) ||
        (candidate.type === 'UpdateExpression' && isVariable(candidate.argument, variable))
      ) {
        reassigned = true
      }
    })
  }
  return !reassigned
}

function constantTruth(node) {
  if (node?.type === 'Literal') return Boolean(node.value)
  if (node?.type === 'UnaryExpression' && node.operator === '!') {
    const value = constantTruth(node.argument)
    return value === undefined ? undefined : !value
  }
  return undefined
}

function isFunction(node) {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type)
}

const assuranceMarker = 1
const factorsMarker = 2
const enrollmentMarker = 4
const completeGate = assuranceMarker | factorsMarker | enrollmentMarker

function markerFor(node) {
  if (node.type === 'CallExpression') {
    const name = memberName(node.callee)
    if (name === 'getAuthenticatorAssuranceLevel') return assuranceMarker
    if (name === 'listFactors') return factorsMarker
  }
  if (node.type === 'Literal' && typeof node.value === 'string' && node.value.includes('/mfa/enroll')) {
    return enrollmentMarker
  }
  if (node.type === 'TemplateElement' && node.value?.raw?.includes('/mfa/enroll')) {
    return enrollmentMarker
  }
  return 0
}

function markerPaths(node, paths = [0], root = false) {
  if (!node || typeof node !== 'object') return paths
  if (!root && (isFunction(node) || node.type === 'MethodDefinition')) return paths

  const marked = paths.map((markers) => markers | markerFor(node))
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    const truth = constantTruth(node.test)
    const tested = markerPaths(node.test, marked)
    const branches = []
    if (truth !== false) branches.push(...markerPaths(node.consequent, tested))
    if (truth !== true) branches.push(...(node.alternate ? markerPaths(node.alternate, tested) : tested))
    return branches
  }
  if (node.type === 'LogicalExpression') {
    const leftPaths = markerPaths(node.left, marked)
    const truth = constantTruth(node.left)
    if (node.operator === '&&') {
      if (truth === false) return leftPaths
      const rightPaths = markerPaths(node.right, leftPaths)
      return truth === true ? rightPaths : [...leftPaths, ...rightPaths]
    }
    if (truth === true) return leftPaths
    const rightPaths = markerPaths(node.right, leftPaths)
    return truth === false ? rightPaths : [...leftPaths, ...rightPaths]
  }
  if (node.type === 'WhileStatement' || node.type === 'ForStatement') {
    const tested = node.test ? markerPaths(node.test, marked) : marked
    if (node.test && constantTruth(node.test) === false) return tested
    const bodyPaths = markerPaths(node.body, tested)
    return node.test ? [...tested, ...bodyPaths] : bodyPaths
  }
  if (node.type === 'BlockStatement' || node.type === 'Program') {
    let current = marked
    for (const statement of node.body) {
      current = markerPaths(statement, current)
      if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(statement.type)) break
    }
    return current
  }

  let current = marked
  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc', 'type'].includes(key)) continue
    if (Array.isArray(value)) {
      for (const child of value) current = markerPaths(child, current)
    } else if (value && typeof value === 'object') {
      current = markerPaths(value, current)
    }
  }
  return current
}

function branchHasCompleteGate(consequent) {
  return markerPaths(consequent, [0], true).some((markers) => markers === completeGate)
}

function scopeBindings(node, parent) {
  const bindings = new Map(parent)
  const statements = node.type === 'Program' || node.type === 'BlockStatement' ? node.body : []
  for (const statement of statements) {
    if (statement.type === 'FunctionDeclaration' && statement.id?.name) {
      bindings.set(statement.id.name, hasRuntimePolicy(statement) ? statement : null)
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.id?.type === 'Identifier') bindings.set(declaration.id.name, null)
      }
    }
    if (statement.type === 'ClassDeclaration' && statement.id?.name) bindings.set(statement.id.name, null)
  }
  return bindings
}

function countCompleteGates(node, bindings = new Map()) {
  if (!node || typeof node !== 'object') return 0
  let currentBindings = bindings
  if (node.type === 'Program' || node.type === 'BlockStatement') {
    currentBindings = scopeBindings(node, bindings)
  }

  let count = 0
  if (
    node.type === 'IfStatement' &&
    node.test?.type === 'CallExpression' &&
    node.test.callee?.type === 'Identifier' &&
    currentBindings.get(node.test.callee.name) &&
    branchHasCompleteGate(node.consequent)
  ) {
    count += 1
  }

  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc', 'type'].includes(key)) continue
    if (Array.isArray(value)) {
      for (const child of value) count += countCompleteGates(child, currentBindings)
    } else if (value && typeof value === 'object') {
      count += countCompleteGates(value, currentBindings)
    }
  }
  return count
}

let trace
try {
  trace = JSON.parse(await readFile(tracePath, 'utf8'))
} catch (error) {
  fail(`cannot read Next middleware trace: ${error.message}`)
}

if (trace?.version !== 1 || !Array.isArray(trace.files)) {
  fail('Next middleware trace has an unsupported shape')
}

const canonicalServerDir = await realpath(serverDir)
const nodeModulesDir = path.join(process.cwd(), 'node_modules')
let canonicalNodeModulesDir
try {
  canonicalNodeModulesDir = await realpath(nodeModulesDir)
} catch {
  canonicalNodeModulesDir = null
}
const tracedJavaScript = []
for (const file of trace.files.filter((entry) => entry.endsWith('.js'))) {
  const lexicalPath = path.resolve(serverDir, file)
  if (lexicalPath.startsWith(`${serverDir}${path.sep}`)) {
    const canonicalPath = await realpath(lexicalPath)
    if (!canonicalPath.startsWith(`${canonicalServerDir}${path.sep}`)) {
      fail(`traced JavaScript escapes the server directory: ${file}`)
    }
    tracedJavaScript.push(canonicalPath)
    continue
  }

  if (canonicalNodeModulesDir && lexicalPath.startsWith(`${nodeModulesDir}${path.sep}`)) {
    const canonicalPath = await realpath(lexicalPath)
    if (!canonicalPath.startsWith(`${canonicalNodeModulesDir}${path.sep}`)) {
      fail(`traced JavaScript escapes the node_modules directory: ${file}`)
    }
    continue
  }

  fail(`traced JavaScript escapes the server directory: ${file}`)
}

if (tracedJavaScript.length === 0) {
  fail('Next middleware trace contains no local JavaScript')
}

let completeGates = 0
for (const file of tracedJavaScript) {
  const source = await readFile(file, 'utf8')
  let ast
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' })
  } catch (error) {
    fail(`cannot parse traced proxy JavaScript ${path.relative(serverDir, file)}: ${error.message}`)
  }

  completeGates += countCompleteGates(ast)
}

if (completeGates !== 1) {
  fail(`expected exactly one traced proxy branch with the complete runtime gate, found ${completeGates}`)
}

console.log('Compiled MFA regression check passed: traced proxy branch retains the complete runtime gate')
