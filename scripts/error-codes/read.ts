import ts from 'typescript'

export function referencedCodeMaps(source: string): string[] {
  const file = ts.createSourceFile('codes.ts', source, ts.ScriptTarget.Latest, true)
  const symbols = new Set<string>()
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /CODES(?:_|$)/.test(node.name.text)
    ) {
      symbols.add(node.name.text)
    }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isNumericLiteral(node.name)) {
        throw new Error('Inline numeric error definitions are unsupported; use a listed code map')
      }
      if (ts.isComputedPropertyName(node.name)) {
        const expression = node.name.expression
        if (ts.isNumericLiteral(expression)) {
          throw new Error('Inline numeric error definitions are unsupported; use a listed code map')
        }
        if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression)) {
          throw new Error(`Unsupported error definition key: ${expression.getText(file)}`)
        }
        symbols.add(expression.expression.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...symbols]
}

// Evaluate only static code tables, never package imports or native addons.
export function readCodeMap(source: string, symbol: string): Record<string, number> {
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
