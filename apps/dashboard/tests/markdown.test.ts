import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../src/lib/markdown.ts'

test('markdown: HTML in the text is shown, never run', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> and `<script>` and [x](javascript:alert(1))')
  assert.ok(!html.includes('<img') && !html.includes('<script'))
  assert.ok(html.includes('&lt;img'))
  assert.ok(!html.includes('href="javascript'), 'only http and https links')
})

test('markdown: code blocks keep their text as is', () => {
  assert.equal(renderMarkdown('```yaml\na: **b**\n<x>\n```'), '<pre><code>a: **b**\n&lt;x&gt;</code></pre>')
})

test('markdown: inline formatting and links', () => {
  assert.equal(renderMarkdown('**Disk** is `sda`, see [docs](https://example.org/a)'),
    '<p><strong>Disk</strong> is <code>sda</code>, see <a href="https://example.org/a" target="_blank" rel="noopener noreferrer">docs</a></p>')
  assert.equal(renderMarkdown('a_b_c and *x*'), '<p>a_b_c and <em>x</em></p>', 'underscores inside words stay')
})

test('markdown: lists, headings and tables', () => {
  assert.equal(renderMarkdown('## Plan\n- one\n- two\n\n1. first\n2. second'),
    '<p class="md-heading">Plan</p><ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>')
  assert.equal(renderMarkdown('| Disk | Size |\n|---|---:|\n| sda | 2 TB |'),
    '<div class="md-table"><table><thead><tr><th>Disk</th><th>Size</th></tr></thead><tbody><tr><td>sda</td><td>2 TB</td></tr></tbody></table></div>')
  assert.equal(renderMarkdown('line one\nline two'), '<p>line one<br>line two</p>')
})
