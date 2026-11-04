<script setup lang="ts">
import type { Component } from 'vue'
import { computed } from 'vue'
import {
  FileArchiveIcon, FileAudioIcon, FileBoxIcon, FileBracesIcon, FileCodeIcon, FileCogIcon, FileIcon,
  FileImageIcon, FileKeyIcon, FileSpreadsheetIcon, FileTerminalIcon, FileTextIcon, FileTypeIcon,
  FileVideoCameraIcon, PresentationIcon,
} from '@lucide/vue'
import FolderGlyph from './FolderGlyph.vue'
import NyanCatIcon from './NyanCatIcon.vue'
import { isNyan } from './nyan'

// Lucide glyph for a file, picked from its extension, or the filled folder for
// a directory. Anything named "nyan" gets the nyan cat instead. Each kind has a
// theme color so a listing is easier to scan; `plain` leaves the color to the
// caller (upload placeholders show their status color).
const props = defineProps<{ name: string; dir?: boolean; open?: boolean; plain?: boolean }>()

// Class names stay literal so Tailwind sees them.
const MEDIA = 'text-info', VIDEO = 'text-secondary', AUDIO = 'text-accent', ARCHIVE = 'text-warning'
const CODE = 'text-primary', DOC = 'text-base-content/70', OTHER = 'text-base-content/60'

const BY_EXT: [Component, string, string[]][] = [
  [FileImageIcon, MEDIA, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'raw', 'cr2', 'nef', 'dng']],
  [FileVideoCameraIcon, VIDEO, ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts']],
  [FileAudioIcon, AUDIO, ['mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'alac']],
  [FileArchiveIcon, ARCHIVE, ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'hsibak']],
  [FileBoxIcon, ARCHIVE, ['iso', 'img', 'dmg', 'qcow2', 'vmdk', 'vdi', 'deb', 'rpm', 'apk', 'appimage']],
  [FileSpreadsheetIcon, DOC, ['csv', 'tsv', 'xls', 'xlsx', 'ods']],
  [PresentationIcon, DOC, ['ppt', 'pptx', 'odp']],
  [FileBracesIcon, CODE, ['json', 'jsonc', 'json5']],
  [FileCogIcon, CODE, ['yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'service']],
  [FileTerminalIcon, CODE, ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd']],
  [FileCodeIcon, CODE, ['js', 'mjs', 'cjs', 'tsx', 'jsx', 'vue', 'py', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'rb', 'php', 'cs', 'swift', 'html', 'htm', 'css', 'scss', 'xml', 'sql', 'lua']],
  [FileKeyIcon, ARCHIVE, ['pem', 'crt', 'cer', 'key', 'pub', 'p12', 'pfx', 'gpg', 'asc']],
  [FileTypeIcon, DOC, ['ttf', 'otf', 'woff', 'woff2']],
  [FileTextIcon, DOC, ['txt', 'md', 'markdown', 'log', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'epub', 'nfo', 'srt', 'sub']],
]
const KINDS = new Map(BY_EXT.flatMap(([icon, tint, exts]) => exts.map(e => [e, { icon, tint }] as const)))

const kind = computed((): { icon: Component; tint: string } => {
  if (isNyan(props.name)) return { icon: NyanCatIcon, tint: '' }
  if (props.dir) return { icon: FolderGlyph, tint: 'text-primary' }
  const dot = props.name.lastIndexOf('.')
  return (dot > 0 && KINDS.get(props.name.slice(dot + 1).toLowerCase())) || { icon: FileIcon, tint: OTHER }
})
</script>

<template>
  <component :is="kind.icon" :open="dir ? open : undefined" :class="plain ? undefined : kind.tint" />
</template>
