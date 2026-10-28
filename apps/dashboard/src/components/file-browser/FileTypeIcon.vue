<script setup lang="ts">
import type { Component } from 'vue'
import { computed } from 'vue'
import {
  FileArchiveIcon, FileAudioIcon, FileBoxIcon, FileBracesIcon, FileCodeIcon, FileCogIcon, FileIcon,
  FileImageIcon, FileKeyIcon, FileSpreadsheetIcon, FileTerminalIcon, FileTextIcon, FileTypeIcon,
  FileVideoCameraIcon, FolderIcon, FolderOpenIcon, PresentationIcon,
} from '@lucide/vue'
import NyanCatIcon from './NyanCatIcon.vue'
import { isNyan } from './nyan'

// Lucide glyph for a file, picked from its extension, or the folder glyph for
// a directory. Anything named "nyan" gets the nyan cat instead.
const props = defineProps<{ name: string; dir?: boolean; open?: boolean }>()

const BY_EXT: [Component, string[]][] = [
  [FileImageIcon, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'raw', 'cr2', 'nef', 'dng']],
  [FileVideoCameraIcon, ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts']],
  [FileAudioIcon, ['mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'alac']],
  [FileArchiveIcon, ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'hsibak']],
  [FileBoxIcon, ['iso', 'img', 'dmg', 'qcow2', 'vmdk', 'vdi', 'deb', 'rpm', 'apk', 'appimage']],
  [FileSpreadsheetIcon, ['csv', 'tsv', 'xls', 'xlsx', 'ods']],
  [PresentationIcon, ['ppt', 'pptx', 'odp']],
  [FileBracesIcon, ['json', 'jsonc', 'json5']],
  [FileCogIcon, ['yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'service']],
  [FileTerminalIcon, ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd']],
  [FileCodeIcon, ['js', 'mjs', 'cjs', 'tsx', 'jsx', 'vue', 'py', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'rb', 'php', 'cs', 'swift', 'html', 'htm', 'css', 'scss', 'xml', 'sql', 'lua']],
  [FileKeyIcon, ['pem', 'crt', 'cer', 'key', 'pub', 'p12', 'pfx', 'gpg', 'asc']],
  [FileTypeIcon, ['ttf', 'otf', 'woff', 'woff2']],
  [FileTextIcon, ['txt', 'md', 'markdown', 'log', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'epub', 'nfo', 'srt', 'sub']],
]
const ICONS = new Map(BY_EXT.flatMap(([icon, exts]) => exts.map(e => [e, icon] as const)))

const icon = computed(() => {
  if (isNyan(props.name)) return NyanCatIcon
  if (props.dir) return props.open ? FolderOpenIcon : FolderIcon
  const dot = props.name.lastIndexOf('.')
  return (dot > 0 && ICONS.get(props.name.slice(dot + 1).toLowerCase())) || FileIcon
})
</script>

<template>
  <component :is="icon" />
</template>
