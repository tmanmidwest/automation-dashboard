import { KeyRound } from 'lucide-react';

/** Brand marks for known provider types; falls back to a generic key. */
export function ProviderIcon({ icon, className = 'h-4 w-4' }: { icon: string; className?: string }) {
  switch (icon) {
    case 'google':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1a6.2 6.2 0 1 1 0-12.4c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 2.6 14.7 1.6 12 1.6a10.4 10.4 0 1 0 0 20.8c6 0 10-4.2 10-10.1 0-.7-.1-1.2-.2-1.7H12z" />
          <path fill="#34A853" d="M3.9 7.3l3.2 2.3C8 7.7 9.8 6.4 12 6.4c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.6 14.7 2.6 12 2.6 8.4 2.6 5.3 4.6 3.9 7.3z" opacity="0" />
        </svg>
      );
    case 'microsoft':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
          <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
          <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
          <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
        </svg>
      );
    case 'authentik':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <rect x="2" y="6" width="20" height="12" rx="3" fill="#FD4B2D" />
          <circle cx="8" cy="12" r="2" fill="#fff" />
          <rect x="12" y="11" width="8" height="2" rx="1" fill="#fff" />
        </svg>
      );
    default:
      return <KeyRound className={className} />;
  }
}
