import ts from 'typescript'

function parseSource(source: string) {
  const file = ts.createSourceFile('codes.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = new Map<string, ts.Expression>()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declarations.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  return { file, declarations }
}

export function referencedCodeMaps(source: string): string[] {
  const { file, declarations } = parseSource(source)
  const symbols = new Set<string>()
  const registrars = new Set(['addCodes'])
  const inspected = new Set<ts.Expression>()

  function definitionOf(identifier: ts.Identifier): ts.Expression | undefined {
    let scope: ts.Node | undefined = identifier.parent
    while (scope) {
      if (ts.isBlock(scope)) {
        const declaration = scope.statements
          .filter(ts.isVariableStatement)
          .flatMap((statement) => [...statement.declarationList.declarations])
          .find((entry) => ts.isIdentifier(entry.name) && entry.name.text === identifier.text)
        if (declaration?.initializer) return declaration.initializer
      }
      if (
        ts.isFunctionDeclaration(scope) &&
        scope.name &&
        registrars.has(scope.name.text) &&
        scope.parameters.some(
          (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text
        )
      ) {
        return undefined
      }
      scope = scope.parent
    }
    const definition = declarations.get(identifier.text)
    if (!definition) throw new Error(`Unresolved error registration: ${identifier.text}`)
    return definition
  }

  function inspect(expression: ts.Expression): void {
    if (ts.isIdentifier(expression)) {
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
        symbols.add(key.expression.expression.text)
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
  const { file, declarations } = parseSource(source)
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

  const value = evaluate(ts.factory.createIdentifier(symbol))
  if (typeof value !== 'object') throw new Error(`${symbol} must be a numeric code map`)
  const result: Record<string, number> = {}
  for (const [name, code] of Object.entries(value)) {
    if (typeof code !== 'number') throw new Error(`${symbol}.${name} must be numeric`)
    result[name] = code
  }
  return result
}
