// Remove comments from the SHIPPED index.html. Build-time only — the source file keeps them.
//
// WHY THIS IS NOT A REGEX SWEEP
// "You can't parse HTML with a regex" is a real rule, and it applies here. The reason it bites is
// that comment syntax is CONTEXT-DEPENDENT:
//   • `<!--` opens a comment in markup, but is ordinary text inside a <script> body and ordinary
//     text inside a quoted attribute value (`<div title="<!-- x -->">`).
//   • `/* */` is a comment inside <style>, but not in markup, and not inside a CSS string
//     (`content: "/* not a comment */"`).
// A document-wide regex knows none of that. It deletes from the first `<!--` to the next `-->`
// wherever those happen to land, and the failure is SILENT: a corrupted entry point that still
// looks plausible and still passes a "does it contain a script tag" check. For the one file we
// hand to a store reviewer, silent corruption is the worst available failure mode.
//
// So this is a small explicit scanner. It tracks exactly the contexts that change what a comment
// is, and nothing else:
//   markup       `<!-- ... -->` is a comment; `<` opens a tag
//   tag          inside `< ... >`, quoted attribute values included, so `<!--` in an attribute is
//                never mistaken for a comment and a `>` inside one never ends the tag early
//   script body  raw text, copied verbatim (JavaScript's comments are not our business)
//   style body   `/* ... */` is a comment, with CSS strings and escapes respected
//
// It is deliberately NOT a general HTML parser and does not pretend to be one: no bogus-comment
// recovery (`<!` / `<?`), no CDATA, no implicit tag closing, no doctype quirks. It handles the
// constructs an index.html actually contains, and `assertShippable` below fails the BUILD if the
// output ever loses a structural landmark — so if this is ever wrong, it is loudly wrong.

// Elements whose bodies are raw text rather than markup, so scanning must not look for tags or
// HTML comments inside them.
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['script', 'style'])

// Markup that must survive the transform, sampled across the whole document (head, top/middle/
// bottom of the inline stylesheet, and body) so a scan that ran away loses at least one of them.
// These are asserted against the OUTPUT, not diffed against the input: the source comments
// themselves mention `<script>`, `<head>` and `<body>`, so a naive before/after tag census would
// report those as "lost tags" every build.
const REQUIRED_LANDMARKS: readonly string[] = [
  '<title>Robot Blackjack Attack</title>',
  'rel="preload"',
  'sdk.crazygames.com/crazygames-sdk-v3.js',
  'touch-action: manipulation',
  '@font-face',
  '#boot-splash {',
  '@keyframes boot-spin',
  '@media (prefers-reduced-motion: reduce)',
  '<div id="app"></div>',
  'id="boot-splash"',
  '</style>',
  '</html>',
]

// Strip every comment from an HTML document, leaving all other bytes untouched.
export function stripHtmlComments(html: string): string {
  let out = ''
  let i = 0
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      // An unterminated comment runs to EOF, which is what a browser does too.
      i = end === -1 ? html.length : end + 3
      continue
    }
    if (html[i] === '<') {
      const tag = readTagName(html, i)
      const afterTag = skipTag(html, i)
      const openTag = html.slice(i, afterTag)
      out += openTag
      i = afterTag
      // A raw-text element's body is copied (script) or CSS-stripped (style) as a unit, so the
      // markup scanner never walks into it.
      if (tag !== null && RAW_TEXT_TAGS.has(tag) && !openTag.endsWith('/>')) {
        const close = findRawTextClose(html, tag, i)
        const body = html.slice(i, close)
        out += tag === 'style' ? stripCssComments(body) : body
        i = close
      }
      continue
    }
    out += html[i]
    i += 1
  }
  return out
}

// The full build transform: strip, tidy the lines the comments occupied, then verify.
export function stripIndexHtmlComments(html: string): string {
  const stripped = tidyBlankLines(stripHtmlComments(html))
  assertShippable(stripped)
  return stripped
}

// Comments here sit on their own lines, so removing only the comment text would strand a blank
// line mid rule-body — that reads as damage rather than as tidy output. The source has no blank
// lines of its own, so dropping every whitespace-only line is exactly the wanted result.
function tidyBlankLines(text: string): string {
  return text.replace(/^[ \t]*\r?\n/gm, '')
}

// Fail the BUILD (not a warning) if the transform ate real markup or left comments behind. This is
// what makes the scanner's limits safe: a construct it mishandles surfaces as a red build instead
// of a quietly broken entry point.
export function assertShippable(html: string): void {
  const missing = REQUIRED_LANDMARKS.filter((landmark) => !html.includes(landmark))
  if (missing.length > 0) {
    throw new Error(
      `strip-html-comments: the transform removed required markup from index.html: ${missing.join(', ')}. ` +
        'Refusing to write a corrupted entry point.',
    )
  }
  // Script bodies are exempt: `-->` and `/*` are legal JavaScript text. Blanking them with a regex
  // is safe HERE in a way it would not be in the transform itself, because over-matching only
  // weakens this check, it never alters the shipped output.
  const scannable = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '<script></script>')
  const leftovers = (['<!--', '-->', '/*', '*/'] as const).filter((marker) => scannable.includes(marker))
  if (leftovers.length > 0) {
    throw new Error(`strip-html-comments: comment markers survived in index.html: ${leftovers.join(' ')}`)
  }
}

// The tag name at `start` (which points at '<'), lowercased, or null if this is not an open tag
// (`</div>`, `<!doctype html>`, a stray '<'). Lexing one bounded token, not parsing structure.
function readTagName(html: string, start: number): string | null {
  const match = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(start, start + 64))
  return match === null ? null : match[1].toLowerCase()
}

// Index just past this tag's '>', honouring quoted attribute values so neither a '>' nor a `<!--`
// inside an attribute is misread.
function skipTag(html: string, start: number): number {
  let quote = ''
  for (let i = start + 1; i < html.length; i += 1) {
    const char = html[i]
    if (quote !== '') {
      if (char === quote) {
        quote = ''
      }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return i + 1
    }
  }
  return html.length
}

// Where a raw-text element's body ends (the index of its closing tag).
function findRawTextClose(html: string, tag: string, from: number): number {
  const found = html.toLowerCase().indexOf(`</${tag}`, from)
  return found === -1 ? html.length : found
}

// Strip `/* */` from CSS, leaving comment-like text inside strings alone.
function stripCssComments(css: string): string {
  let out = ''
  let i = 0
  let quote = ''
  while (i < css.length) {
    const char = css[i]
    if (quote !== '') {
      if (char === '\\') {
        out += css.slice(i, i + 2) // an escape carries its next char, whatever it is
        i += 2
        continue
      }
      if (char === quote) {
        quote = ''
      }
      out += char
      i += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      out += char
      i += 1
      continue
    }
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 2
      continue
    }
    out += char
    i += 1
  }
  return out
}
