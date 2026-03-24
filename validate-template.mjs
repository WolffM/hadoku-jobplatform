#!/usr/bin/env node
/**
 * Template Validation Script - UI Template
 *
 * This script validates that a UI template has been properly hydrated.
 * - When run on raw template: FAILS (placeholders found)
 * - When run on hydrated template: PASSES (no placeholders)
 *
 * Usage:
 *   node validate-template.mjs              # Expect failure
 *   node validate-template.mjs --expect-fail # Exit 0 if placeholders found (for testing raw template)
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Placeholder patterns that indicate an unhydrated template
const PLACEHOLDER_PATTERNS = [
  // Package name placeholder
  { pattern: /@wolffm\/your-app/g, description: '@wolffm/your-app package name' },
  // Repo URL placeholder
  { pattern: /WolffM\/your-app\.git/g, description: 'your-app repository URL' },
  // Logger prefix placeholder
  { pattern: /\[your-app\]/g, description: '[your-app] logger prefix' },
  // CSS class prefix placeholder
  { pattern: /\.your-app-/g, description: '.your-app- CSS class prefix' },
  // Generic description placeholder
  { pattern: /Your app description/g, description: 'Generic description placeholder' },
  // Generic title placeholder
  { pattern: /<title>Your App<\/title>/gi, description: 'Generic title placeholder' }
]

// Files to skip during validation
const SKIP_FILES = [
  'validate-template.mjs',
  'TEMPLATE.md', // Contains examples of placeholders
  'node_modules',
  'dist',
  '.git'
]

// File extensions to check
const CHECK_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md', '.yml']

function shouldCheckFile(filePath) {
  const fileName = filePath.split(/[/\\]/).pop()

  // Skip excluded files
  if (SKIP_FILES.some(skip => filePath.includes(skip))) {
    return false
  }

  // Only check specific extensions
  return CHECK_EXTENSIONS.some(ext => filePath.endsWith(ext))
}

function findFiles(dir, files = []) {
  const entries = readdirSync(dir)

  for (const entry of entries) {
    const fullPath = join(dir, entry)

    if (SKIP_FILES.includes(entry)) {
      continue
    }

    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      findFiles(fullPath, files)
    } else if (shouldCheckFile(fullPath)) {
      files.push(fullPath)
    }
  }

  return files
}

function validateFile(filePath) {
  const content = readFileSync(filePath, 'utf-8')
  const relativePath = filePath.replace(__dirname, '').replace(/^[/\\]/, '')
  const issues = []

  for (const { pattern, description } of PLACEHOLDER_PATTERNS) {
    const matches = content.match(pattern)
    if (matches) {
      issues.push({
        file: relativePath,
        pattern: description,
        count: matches.length
      })
    }
  }

  return issues
}

function main() {
  const expectFail = process.argv.includes('--expect-fail')

  console.log('Validating UI template...\n')

  const files = findFiles(__dirname)
  const allIssues = []

  for (const file of files) {
    const issues = validateFile(file)
    allIssues.push(...issues)
  }

  if (allIssues.length > 0) {
    console.log('Found placeholder patterns:\n')
    for (const issue of allIssues) {
      console.log(`  ${issue.file}`)
      console.log(`    - ${issue.pattern} (${issue.count} occurrence${issue.count > 1 ? 's' : ''})`)
    }
    console.log(`\nTotal: ${allIssues.length} placeholder issue(s) found`)

    if (expectFail) {
      console.log('\n--expect-fail: Placeholders found as expected (raw template)')
      process.exit(0)
    } else {
      console.log('\nTemplate has not been fully hydrated. Replace all placeholders before use.')
      process.exit(1)
    }
  } else {
    console.log('No placeholder patterns found - template is hydrated.')

    if (expectFail) {
      console.log('\n--expect-fail: Expected to find placeholders but none found')
      process.exit(1)
    } else {
      process.exit(0)
    }
  }
}

main()
