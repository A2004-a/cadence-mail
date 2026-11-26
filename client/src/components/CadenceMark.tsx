export const ACCENT_PRESETS = [
  { name: 'Mineral Cobalt', light: '#1D4ED8', dark: '#60A5FA' },
  { name: 'Deep Pine', light: '#047857', dark: '#34D399' },
  { name: 'Ocean Teal', light: '#0F766E', dark: '#2DD4BF' },
  { name: 'Warm Amber', light: '#B45309', dark: '#FBBF24' },
  { name: 'Plum Violet', light: '#6D28D9', dark: '#A78BFA' },
  { name: 'Crimson Berry', light: '#BE123C', dark: '#FB7185' },
];

export function CadenceMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="24" height="24" rx="7" fill="var(--accent)" />
      <path
        d="M7.5 10.25L14 14.75L20.5 10.25"
        stroke="white"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 14.75L14 19.25L20.5 14.75"
        stroke="white"
        strokeOpacity="0.65"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function getInitials(nameOrEmail: string): string {
  const clean = (nameOrEmail || '?').trim();
  const parts = clean.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export function formatRelativeDate(
  iso: string,
  mode: 'relative' | 'short' | 'iso' = 'relative',
  timeFormat: '12h' | '24h' = '12h'
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (mode === 'iso') return d.toISOString().slice(0, 16).replace('T', ' ');

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const hour12 = timeFormat === '12h';

  if (mode === 'relative' && diffMs >= 0 && diffMs < 86_400_000 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12 });
  }
  if (mode === 'relative' && diffMs >= 0 && diffMs < 6 * 86_400_000) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatFullTimestamp(iso: string, timeFormat: '12h' | '24h' = '12h'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: timeFormat === '12h',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AvatarBadge({
  name,
  color = '#1D4ED8',
  size = 32,
}: {
  name: string;
  color?: string;
  size?: number;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: '9999px',
        background: `color-mix(in srgb, ${color} 15%, var(--bg-subtle))`,
        color: color,
        border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(10, Math.round(size * 0.36)),
        fontWeight: 600,
        letterSpacing: '0.02em',
        userSelect: 'none',
      }}
      aria-hidden="true"
    >
      {getInitials(name)}
    </span>
  );
}
