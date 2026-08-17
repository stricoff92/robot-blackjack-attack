import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assertShippable, stripHtmlComments, stripIndexHtmlComments } from './strip-html-comments'

const INDEX_HTML = fileURLToPath(new URL('../index.html', import.meta.url))

describe('stripHtmlComments: the ordinary cases', () => {
  it('removes an HTML comment from markup', () => {
    expect(stripHtmlComments('<p>a</p><!-- gone --><p>b</p>')).toBe('<p>a</p><p>b</p>')
  })

  it('removes CSS comments from a <style> body', () => {
    expect(stripHtmlComments('<style>a{/* gone */color:red}</style>')).toBe('<style>a{color:red}</style>')
  })

  it('leaves the doctype alone (it starts with <! but is not a comment)', () => {
    expect(stripHtmlComments('<!doctype html><p>x</p>')).toBe('<!doctype html><p>x</p>')
  })

  it('runs an unterminated comment to EOF, as a browser does', () => {
    expect(stripHtmlComments('<p>a</p><!-- never closed')).toBe('<p>a</p>')
  })
})

// These are the cases a document-wide regex gets WRONG. Each one is a place where `<!--` or `/*`
// is ordinary text rather than a comment opener, and a blind sweep would delete from there to the
// next closer — silently taking real markup with it.
describe('stripHtmlComments: context sensitivity (why a regex sweep is unsafe)', () => {
  it('does not treat <!-- inside a quoted attribute value as a comment', () => {
    const html = '<div title="<!-- x -->"><p>kept</p></div>'
    expect(stripHtmlComments(html)).toBe(html)
  })

  it('does not let a > inside an attribute value end the tag early', () => {
    const html = '<div data-a="a>b"><!-- gone --><p>kept</p></div>'
    expect(stripHtmlComments(html)).toBe('<div data-a="a>b"><p>kept</p></div>')
  })

  it('leaves a <script> body verbatim, including comment-like text', () => {
    const html = '<script>var a = "-->"; /* kept */ // kept\n</script>'
    expect(stripHtmlComments(html)).toBe(html)
  })

  it('does not strip /* inside a CSS string', () => {
    const html = '<style>a::after{content:"/* not a comment */"}</style>'
    expect(stripHtmlComments(html)).toBe(html)
  })

  it('does not strip /* inside a single-quoted CSS string, escapes included', () => {
    const html = "<style>a{font-family:'a\\'/* b */c'}</style>"
    expect(stripHtmlComments(html)).toBe(html)
  })

  it('does not treat markup /* as a CSS comment outside <style>', () => {
    const html = '<p>2 /* 3 */ 4</p>'
    expect(stripHtmlComments(html)).toBe(html)
  })

  it('strips each of several style blocks independently', () => {
    expect(stripHtmlComments('<style>a{/*x*/}</style><p>y</p><style>b{/*z*/}</style>')).toBe(
      '<style>a{}</style><p>y</p><style>b{}</style>',
    )
  })
})

describe('assertShippable', () => {
  it('throws when the transform has eaten required markup', () => {
    expect(() => assertShippable('<html></html>')).toThrow(/removed required markup/)
  })

  it('throws when comment markers survive outside a script body', () => {
    const intact = stripIndexHtmlComments(readFileSync(INDEX_HTML, 'utf8'))
    expect(() => assertShippable(`${intact}<!-- leftover -->`)).toThrow(/comment markers survived/)
  })

  it('does not flag comment-like text inside a script body', () => {
    const intact = stripIndexHtmlComments(readFileSync(INDEX_HTML, 'utf8'))
    expect(() => assertShippable(`${intact}<script>var a = "-->" /* ok */</script>`)).not.toThrow()
  })
})

// Pin the transform against the file it actually runs on, so an edit to index.html that the scanner
// would mishandle fails here rather than in a shipped build.
describe('stripIndexHtmlComments: the real index.html', () => {
  const source = readFileSync(INDEX_HTML, 'utf8')
  const output = stripIndexHtmlComments(source)

  it('starts from a source that genuinely has comments to remove', () => {
    expect(source).toContain('<!--')
    expect(source).toContain('/*')
  })

  it('produces no comments of either syntax', () => {
    expect(output).not.toContain('<!--')
    expect(output).not.toContain('-->')
    expect(output).not.toContain('/*')
    expect(output).not.toContain('*/')
  })

  it('keeps every structural landmark (assertShippable ran inside)', () => {
    expect(output).toContain('<div id="app"></div>')
    expect(output).toContain('id="boot-splash"')
    expect(output).toContain('sdk.crazygames.com/crazygames-sdk-v3.js')
    expect(output).toContain('@media (prefers-reduced-motion: reduce)')
    expect(output).toMatch(/^<!doctype html>/i)
  })

  it('leaves no blank lines behind where the comments were', () => {
    expect(output.split('\n').filter((line) => line.trim() === '' && line !== '')).toHaveLength(0)
  })

  it('removes ONLY comments and their blank lines: every other line survives verbatim', () => {
    // The strongest invariant available without a diff: each output line must appear in the source,
    // in order. So the scanner can drop lines (comments) but can never invent, merge, or mangle one.
    const sourceLines = source.split('\n')
    let cursor = 0
    for (const line of output.split('\n')) {
      const found = sourceLines.indexOf(line, cursor)
      expect(found, `output line not found in source, in order: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0)
      cursor = found + 1
    }
  })
})
