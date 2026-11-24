import type { Component } from 'vue'
import {
  BellIcon, BookOpenIcon, BookmarkIcon, BotIcon, BoxIcon, CalendarIcon, CameraIcon, ChartLineIcon, CloudIcon,
  CodeIcon, CpuIcon, DatabaseIcon, DownloadIcon, FileTextIcon, FilmIcon, Gamepad2Icon, GlobeIcon, HardDriveIcon,
  HeadphonesIcon, HeartIcon, HouseIcon, ImageIcon, KeyRoundIcon, LockIcon, MailIcon, MessageCircleIcon, MusicIcon,
  NetworkIcon, NewspaperIcon, PodcastIcon, RadioIcon, RssIcon, ServerIcon, ShieldIcon, TerminalIcon, TvIcon,
  UtensilsIcon, WalletIcon, WorkflowIcon, WrenchIcon,
} from '@lucide/vue'

// The generic icons an app added by hand can wear (catalog apps have their
// logo). The id is what the compose file stores, so ids never change.
export const APP_GLYPHS: ReadonlyArray<{ id: string; icon: Component }> = [
  { id: 'film', icon: FilmIcon }, { id: 'tv', icon: TvIcon }, { id: 'music', icon: MusicIcon },
  { id: 'headphones', icon: HeadphonesIcon }, { id: 'podcast', icon: PodcastIcon }, { id: 'radio', icon: RadioIcon },
  { id: 'image', icon: ImageIcon }, { id: 'camera', icon: CameraIcon }, { id: 'gamepad', icon: Gamepad2Icon },
  { id: 'book', icon: BookOpenIcon }, { id: 'newspaper', icon: NewspaperIcon }, { id: 'rss', icon: RssIcon },
  { id: 'file', icon: FileTextIcon }, { id: 'bookmark', icon: BookmarkIcon }, { id: 'download', icon: DownloadIcon },
  { id: 'cloud', icon: CloudIcon }, { id: 'database', icon: DatabaseIcon }, { id: 'server', icon: ServerIcon },
  { id: 'hard-drive', icon: HardDriveIcon }, { id: 'network', icon: NetworkIcon }, { id: 'globe', icon: GlobeIcon },
  { id: 'shield', icon: ShieldIcon }, { id: 'lock', icon: LockIcon }, { id: 'key', icon: KeyRoundIcon },
  { id: 'home', icon: HouseIcon }, { id: 'chat', icon: MessageCircleIcon }, { id: 'mail', icon: MailIcon },
  { id: 'calendar', icon: CalendarIcon }, { id: 'bell', icon: BellIcon }, { id: 'chart', icon: ChartLineIcon },
  { id: 'wallet', icon: WalletIcon }, { id: 'food', icon: UtensilsIcon }, { id: 'heart', icon: HeartIcon },
  { id: 'code', icon: CodeIcon }, { id: 'terminal', icon: TerminalIcon }, { id: 'workflow', icon: WorkflowIcon },
  { id: 'bot', icon: BotIcon }, { id: 'wrench', icon: WrenchIcon }, { id: 'cpu', icon: CpuIcon }, { id: 'box', icon: BoxIcon },
]

const BY_ID = new Map(APP_GLYPHS.map(g => [g.id, g.icon]))

/** The icon for a stored id, or null for none or an id this version lacks. */
export function appGlyph(id: string | null | undefined): Component | null {
  return id ? BY_ID.get(id) ?? null : null
}
