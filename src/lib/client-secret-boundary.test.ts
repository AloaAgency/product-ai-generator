import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = path.resolve(process.cwd(), 'src')
const CODE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const FORBIDDEN_CLIENT_SECRET_NAMES = new Set([
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'LTX_API_KEY',
])

function listCodeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listCodeFiles(absolutePath)
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [absolutePath] : []
  })
}

function createSourceFile(filePath: string) {
  const scriptKind = filePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  )
}

function hasUseClientDirective(sourceFile: ts.SourceFile) {
  const first = sourceFile.statements[0]
  return Boolean(
    first
    && ts.isExpressionStatement(first)
    && ts.isStringLiteral(first.expression)
    && first.expression.text === 'use client'
  )
}

function resolveLocalImport(
  importer: string,
  specifier: string,
  knownFiles: Set<string>
) {
  const unresolved = specifier.startsWith('@/')
    ? path.join(SOURCE_ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(importer), specifier)
      : null
  if (!unresolved) return null

  for (const extension of CODE_EXTENSIONS) {
    const candidate = `${unresolved}${extension}`
    if (knownFiles.has(candidate)) return candidate
  }
  for (const extension of CODE_EXTENSIONS.slice(1)) {
    const candidate = path.join(unresolved, `index${extension}`)
    if (knownFiles.has(candidate)) return candidate
  }
  return null
}

function getRuntimeImportSpecifiers(sourceFile: ts.SourceFile) {
  const specifiers: string[] = []

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text)
      }
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text)
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)

  return specifiers
}

function getProcessEnvName(node: ts.Node): string | null {
  if (
    ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'process'
    && node.expression.name.text === 'env'
  ) {
    return node.name.text
  }

  if (
    ts.isElementAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'process'
    && node.expression.name.text === 'env'
    && node.argumentExpression
    && ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text
  }

  return null
}

describe('client secret boundary', () => {
  it('keeps private env access and video generation out of client import graphs', () => {
    const files = listCodeFiles(SOURCE_ROOT)
    const knownFiles = new Set(files)
    const sourceFiles = new Map(files.map((file) => [file, createSourceFile(file)]))
    const clientRoots = files.filter((file) => {
      const sourceFile = sourceFiles.get(file)
      return file.includes('.client.') || Boolean(sourceFile && hasUseClientDirective(sourceFile))
    })

    const reachable = new Set(clientRoots)
    const queue = [...clientRoots]
    while (queue.length > 0) {
      const importer = queue.shift()
      if (!importer) continue
      const sourceFile = sourceFiles.get(importer)
      if (!sourceFile) continue

      for (const specifier of getRuntimeImportSpecifiers(sourceFile)) {
        const resolved = resolveLocalImport(importer, specifier, knownFiles)
        if (!resolved || reachable.has(resolved)) continue
        reachable.add(resolved)
        queue.push(resolved)
      }
    }

    const violations: string[] = []
    for (const file of reachable) {
      const sourceFile = sourceFiles.get(file)
      if (!sourceFile) continue
      const visit = (node: ts.Node) => {
        const envName = getProcessEnvName(node)
        if (envName && !envName.startsWith('NEXT_PUBLIC_')) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
          violations.push(`${path.relative(process.cwd(), file)}:${line} process.env.${envName}`)
        }
        if (ts.isIdentifier(node) && FORBIDDEN_CLIENT_SECRET_NAMES.has(node.text)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
          violations.push(`${path.relative(process.cwd(), file)}:${line} ${node.text}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }

    expect(violations).toEqual([])
    expect(reachable.has(path.join(SOURCE_ROOT, 'lib/video-generation.ts'))).toBe(false)
  })
})
