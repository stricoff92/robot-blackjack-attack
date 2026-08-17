// Maintenance codemod — suffix every TypeScript `private` class member with `_`.
//
// WHY: the production build (vite.config.ts) minifies with terser + `mangle.properties.regex:
// /_$/`, which renames every property whose name ends in `_`. That's an opt-in obfuscation
// convention: `private` members carry a trailing `_` so terser mangles them, while public API,
// serialized RunState fields, and Web/CrazyGames SDK properties (none of which end in `_`) are
// left readable and intact. See the long comment in vite.config.ts for the full rules.
//
// `private` is compiler-enforced as class-local, so renaming the declaration + its `this.`
// references (done here via the language service) is safe and fully checked by `tsc` afterwards.
// Only class declarations are walked — interfaces / type literals / serialized DTO shapes are
// never touched.
//
// RUN (ts-morph is a dev-only tool, not a project dependency):
//   npm i -D ts-morph        # or: npx -y -p ts-morph@23 node scripts/mangle-privates.mjs
//   node scripts/mangle-privates.mjs
//   npx tsc --noEmit && npx vitest run   # verify nothing broke
//
// Idempotent: members already ending in `_` are skipped, so it's safe to re-run after adding new
// private members.
import { fileURLToPath } from 'node:url'
import { Project, SyntaxKind, Node } from 'ts-morph'

const PROJECT = fileURLToPath(new URL('..', import.meta.url))
const project = new Project({ tsConfigFilePath: `${PROJECT}/tsconfig.json` })

// Real source only — never the *.test.ts files (renaming there buys nothing and could churn
// tests that poke privates via `as any`).
const files = project
  .getSourceFiles()
  .filter((f) => f.getFilePath().includes('/src/') && !f.getFilePath().endsWith('.test.ts'))

function hasPrivateKeyword(node) {
  return node.getModifiers?.().some((m) => m.getKind() === SyntaxKind.PrivateKeyword) ?? false
}

// A renameable, still-un-suffixed private member (or private ctor param-property) in `file`, or null.
function nextTarget(file) {
  for (const cls of file.getClasses()) {
    for (const member of cls.getMembers()) {
      if (
        (Node.isMethodDeclaration(member) ||
          Node.isPropertyDeclaration(member) ||
          Node.isGetAccessorDeclaration(member) ||
          Node.isSetAccessorDeclaration(member)) &&
        hasPrivateKeyword(member)
      ) {
        const name = member.getName?.()
        if (name && /^[A-Za-z$][\w$]*$/.test(name) && !name.endsWith('_')) return member
      }
      // Constructor parameter properties: `constructor(private readonly foo = 0)`
      if (Node.isConstructorDeclaration(member)) {
        for (const param of member.getParameters()) {
          if (hasPrivateKeyword(param)) {
            const name = param.getName()
            if (name && /^[A-Za-z$][\w$]*$/.test(name) && !name.endsWith('_')) return param
          }
        }
      }
    }
  }
  return null
}

let total = 0
const perFile = {}
for (const file of files) {
  let count = 0
  // Re-query fresh after each rename so no wrapped node goes stale as text shifts.
  for (let target = nextTarget(file); target; target = nextTarget(file)) {
    target.rename(`${target.getName()}_`)
    count += 1
    total += 1
    if (total > 5000) throw new Error('runaway rename loop — aborting')
  }
  if (count) perFile[file.getBaseName()] = count
}

project.saveSync()

console.log(`Renamed ${total} private members across ${Object.keys(perFile).length} files:`)
for (const [f, c] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${f}`)
}
