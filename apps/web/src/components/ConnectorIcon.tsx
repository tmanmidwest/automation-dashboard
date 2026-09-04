import { Server, Cloud, Building2, Archive, House, Puzzle } from 'lucide-react';

/** Maps a connector manifest icon key to a glyph. */
export function ConnectorIcon({ icon, className = 'h-5 w-5' }: { icon?: string; className?: string }) {
  switch (icon) {
    case 'proxmox':
      return <Server className={className} />;
    case 'aws':
      return <Cloud className={className} />;
    case 'entra':
      return <Building2 className={className} />;
    case 'backblaze':
      return <Archive className={className} />;
    case 'home-assistant':
      return <House className={className} />;
    default:
      return <Puzzle className={className} />;
  }
}
