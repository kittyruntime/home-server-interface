export interface FormatterEntry {
  parser: string
  loadPlugins: () => Promise<any[]>
}

const jsonEntry: FormatterEntry = {
  parser: 'json',
  loadPlugins: () => Promise.all([import('prettier/plugins/babel'), import('prettier/plugins/estree')]),
}

const yamlEntry: FormatterEntry = {
  parser: 'yaml',
  loadPlugins: async () => [await import('prettier/plugins/yaml')],
}

function cssEntry(parser: 'css' | 'scss' | 'less'): FormatterEntry {
  return {
    parser,
    loadPlugins: async () => [await import('prettier/plugins/postcss')],
  }
}

const htmlEntry: FormatterEntry = {
  parser: 'html',
  loadPlugins: () =>
    Promise.all([
      import('prettier/plugins/html'),
      import('prettier/plugins/postcss'),
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
    ]),
}

const markdownEntry: FormatterEntry = {
  parser: 'markdown',
  loadPlugins: async () => [await import('prettier/plugins/markdown')],
}

const jsEntry: FormatterEntry = {
  parser: 'babel',
  loadPlugins: () => Promise.all([import('prettier/plugins/babel'), import('prettier/plugins/estree')]),
}

const tsEntry: FormatterEntry = {
  parser: 'typescript',
  loadPlugins: () => Promise.all([import('prettier/plugins/typescript'), import('prettier/plugins/estree')]),
}

const EXT_MAP: Record<string, FormatterEntry> = {
  json: jsonEntry,
  yaml: yamlEntry,
  yml: yamlEntry,
  css: cssEntry('css'),
  scss: cssEntry('scss'),
  less: cssEntry('less'),
  html: htmlEntry,
  md: markdownEntry,
  markdown: markdownEntry,
  js: jsEntry,
  mjs: jsEntry,
  cjs: jsEntry,
  jsx: jsEntry,
  ts: tsEntry,
  tsx: tsEntry,
  mts: tsEntry,
  cts: tsEntry,
}

function extname(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i === -1 ? '' : filename.slice(i + 1).toLowerCase()
}

export function getFormatter(filename: string): FormatterEntry | null {
  return EXT_MAP[extname(filename)] ?? null
}

let standaloneMod: typeof import('prettier/standalone') | null = null

export async function formatContent(
  filename: string,
  content: string,
  cursorOffset = 0,
): Promise<{ formatted: string; cursorOffset: number }> {
  const entry = getFormatter(filename)
  if (!entry) throw new Error(`No formatter for ${filename}`)
  if (!standaloneMod) standaloneMod = await import('prettier/standalone')
  const plugins = await entry.loadPlugins()
  const result = await standaloneMod.formatWithCursor(content, {
    parser: entry.parser,
    plugins,
    cursorOffset,
  })
  return { formatted: result.formatted, cursorOffset: result.cursorOffset }
}
