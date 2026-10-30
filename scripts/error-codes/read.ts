import ts from 'typescript'

function parseSource(source: string) {
  const file = ts.createSourceFile('codes.ts', source, ts.ScriptTarget.Latest, true)
  // Bind this file in isolation: resolve lexical scopes without loading dependencies.
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file.fileName ? file : undefined),
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === file.fileName,
    readFile: (name) => (name === file.fileName ? source : undefined)
  }
  const checker = ts
    .createProgram([file.fileName], { noLib: true, noResolve: true }, host)
    .getTypeChecker()
  const declarations = new Map<string, ts.Expression>()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declarations.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  const checked = new Set<ts.Symbol>()
  function assertUnmodified(identifier: ts.Identifier): void {
    const binding = checker.getSymbolAtLocation(identifier)
    if (!binding || checked.has(binding)) return
    checked.add(binding)

    function visit(node: ts.Node): void {
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === binding) {
        let target: ts.Node = node
        let readsProperty = false
        while (
          (ts.isPropertyAccessExpression(target.parent) ||
            ts.isElementAccessExpression(target.parent) ||
            ts.isParenthesizedExpression(target.parent) ||
            ts.isAsExpression(target.parent)) &&
          target.parent.expression === target
        ) {
          target = target.parent
          if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
            readsProperty = true
          }
        }
        const parent = target.parent
        if (
          (ts.isBinaryExpression(parent) &&
            parent.left === target &&
            parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
          ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
            (parent.operator === ts.SyntaxKind.PlusPlusToken ||
              parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
          ts.isDeleteExpression(parent) ||
          (ts.isCallExpression(parent) &&
            parent.arguments[0] === target &&
            [
              'Object.assign',
              'Object.defineProperty',
              'Object.defineProperties',
              'Reflect.set',
              'Reflect.defineProperty',
              'Reflect.deleteProperty'
            ].includes(parent.expression.getText(file)))
        ) {
          throw new Error(`Mutated error table is unsupported: ${identifier.text}`)
        }
        if (
          ts.isVariableDeclaration(parent) &&
          !readsProperty &&
          !(checker.getTypeAtLocation(node).flags & ts.TypeFlags.NumberLike) &&
          parent.initializer === target &&
          ts.isIdentifier(parent.name)
        ) {
          assertUnmodified(parent.name)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return { file, declarations, checker, assertUnmodified }
}

export function referencedCodeMaps(source: string): string[] {
  const { file, declarations, checker, assertUnmodified } = parseSource(source)
  const symbols = new Set<string>()
  const registrars = new Set(['addCodes'])
  const inspected = new Set<ts.Expression>()

  function definitionOf(identifier: ts.Identifier): ts.Expression | undefined {
    const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return declaration.initializer
    }
    if (
      declaration &&
      ts.isParameter(declaration) &&
      ts.isFunctionDeclaration(declaration.parent) &&
      declaration.parent.name &&
      registrars.has(declaration.parent.name.text)
    ) {
      return undefined
    }
    throw new Error(`Unresolved error registration: ${identifier.text}`)
  }

  function inspect(expression: ts.Expression): void {
    if (ts.isIdentifier(expression)) {
      assertUnmodified(expression)
      const definition = definitionOf(expression)
      // Wrapper parameters are checked at the wrapper's call sites.
      if (definition && !inspected.has(definition)) {
        inspected.add(definition)
        inspect(definition)
      }
      return
    }
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (!ts.isPropertyAssignment(property)) {
          throw new Error('Unsupported error definition property')
        }
        const key = property.name
        if (
          ts.isNumericLiteral(key) ||
          (ts.isComputedPropertyName(key) && ts.isNumericLiteral(key.expression))
        ) {
          throw new Error('Inline numeric error definitions are unsupported; use a listed code map')
        }
        if (
          !ts.isComputedPropertyName(key) ||
          !ts.isPropertyAccessExpression(key.expression) ||
          !ts.isIdentifier(key.expression.expression)
        ) {
          throw new Error(`Unsupported error definition key: ${key.getText(file)}`)
        }
        const map = key.expression.expression
        const binding = checker.getSymbolAtLocation(map)
        const declaration = binding?.valueDeclaration ?? binding?.declarations?.[0]
        if (
          declaration &&
          (!ts.isVariableDeclaration(declaration) ||
            declaration.initializer !== declarations.get(map.text))
        ) {
          throw new Error(
            `Unlisted code table: ${map.text}; registered maps must resolve to a module-scope declaration`
          )
        }
        symbols.add(map.text)
      }
      return
    }
    if (ts.isCallExpression(expression)) {
      if (
        ['Object.fromEntries', 'Object.entries', 'Object.freeze'].includes(
          expression.expression.getText(file)
        )
      ) {
        const argument = expression.arguments[0]
        if (argument) return inspect(argument)
      }
      if (
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === 'filter'
      ) {
        return inspect(expression.expression.expression)
      }
    }
    throw new Error(`Unsupported error registration: ${expression.getText(file)}`)
  }

  function visit(node: ts.Node, onCall: (call: ts.CallExpression) => void): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) {
        const name = ts.isIdentifier(callee) ? callee.text : callee.name.text
        if (registrars.has(name)) onCall(node)
      }
    }
    ts.forEachChild(node, (child) => visit(child, onCall))
  }
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text
      visit(statement, () => registrars.add(name))
    }
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (binding.propertyName?.text === 'addCodes') registrars.add(binding.name.text)
        }
      }
    }
  }
  visit(file, (call) => {
    const argument = call.arguments[0]
    if (argument) inspect(argument)
  })
  return [...symbols]
}

// Evaluate only static code tables, never package imports or native addons.
export function readCodeMap(source: string, symbol: string): Record<string, number> {
  const { file, declarations, assertUnmodified } = parseSource(source)
  const resolving = new Set<string>()
  type Value = number | { [key: string]: Value }

  function evaluate(node: ts.Expression): Value {
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (
      ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return evaluate(node.expression)
    }
    if (ts.isIdentifier(node)) {
      assertUnmodified(node)
      const expression = declarations.get(node.text)
      if (!expression) throw new Error(`Missing code table or constant: ${node.text}`)
      if (resolving.has(node.text)) throw new Error(`Cyclic code constant: ${node.text}`)
      resolving.add(node.text)
      const value = evaluate(expression)
      resolving.delete(node.text)
      return value
    }
    if (ts.isPropertyAccessExpression(node)) {
      const object = evaluate(node.expression)
      if (typeof object === 'object' && Object.hasOwn(object, node.name.text)) {
        return object[node.name.text]
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === 'Object.freeze' &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0]
      if (argument) return evaluate(argument)
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, Value> = Object.create(null)
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
          throw new Error(`Unsupported code property: ${property.getText(file)}`)
        }
        const name = property.name.text
        if (Object.hasOwn(result, name)) throw new Error(`Duplicate code name: ${name}`)
        result[name] = evaluate(property.initializer)
      }
      return result
    }
    throw new Error(`Unsupported numeric code expression: ${node.getText(file)}`)
  }

  const expression = declarations.get(symbol)
  if (!expression) throw new Error(`Missing code table or constant: ${symbol}`)
  if (ts.isVariableDeclaration(expression.parent) && ts.isIdentifier(expression.parent.name)) {
    assertUnmodified(expression.parent.name)
  }
  const value = evaluate(expression)
  if (typeof value !== 'object') throw new Error(`${symbol} must be a numeric code map`)
  const result: Record<string, number> = {}
  for (const [name, code] of Object.entries(value)) {
    if (typeof code !== 'number') throw new Error(`${symbol}.${name} must be numeric`)
    result[name] = code
  }
  return result
}
