// The small part of Markdown an AI assistant writes: paragraphs, headings,
// lists, code, tables, bold, italic and links. Everything is escaped first,
// so the only HTML in the result is the one made here: model output (which
// may quote file contents) can never inject markup.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function inline(text: string): string {
  // Code spans first: nothing inside them is formatted.
  const codes: string[] = []
  let s = text.replace(/`([^`\n]+)`/g, (_m, c: string) => { codes.push(c); return `\uE000${codes.length - 1}\uE000` })
  s = escapeHtml(s)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
  return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => `<code>${escapeHtml(codes[Number(i)]!)}</code>`)
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!)
      i++
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) { i++; continue }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      out.push(`<p class="md-heading">${inline(heading[2]!)}</p>`)
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!))
      out.push(`<div class="md-table"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    const bullet = /^\s*[-*+]\s+/
    const numbered = /^\s*\d+[.)]\s+/
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line)
      const marker = ordered ? numbered : bullet
      const items: string[] = []
      while (i < lines.length && marker.test(lines[i]!)) {
        let item = lines[i++]!.replace(marker, '')
        // Continuation lines, indented under the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !bullet.test(lines[i]!) && !numbered.test(lines[i]!)) item += ' ' + lines[i++]!.trim()
        items.push(`<li>${inline(item)}</li>`)
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^\s*```/.test(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!) &&
      !bullet.test(lines[i]!) && !numbered.test(lines[i]!) &&
      !(lines[i]!.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!))) para.push(lines[i++]!)
    out.push(`<p>${para.map(inline).join('<br>')}</p>`)
  }
  return out.join('')
}
