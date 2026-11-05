import { parentPort } from 'node:worker_threads'
import { renderMarkdown } from '../src/lib/markdown.ts'

parentPort?.on('message', (source: string) => {
  parentPort?.postMessage(renderMarkdown(source))
})
