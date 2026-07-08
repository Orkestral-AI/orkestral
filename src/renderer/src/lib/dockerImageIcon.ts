import {
  Database,
  Server,
  Mail,
  Box,
  Globe,
  Table2,
  Send,
  Leaf,
  Hexagon,
  Search,
  type LucideIcon,
} from 'lucide-react';

/** Paleta (mesmos hexes dos accents do design system) pro fallback por hash. */
const PALETTE = ['#22c55e', '#3b82f6', '#f87171', '#eab308', '#fb923c', '#a78bfa', '#2dd4bf'];

export function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

interface Mapping {
  match: RegExp;
  Icon: LucideIcon;
  color: string;
}

// Imagens comuns → ícone + cor reconhecível (estilo OrbStack, mas com lucide).
const MAP: Mapping[] = [
  { match: /mongo/, Icon: Leaf, color: '#22c55e' },
  { match: /redis/, Icon: Database, color: '#f87171' },
  { match: /postgres|pgsql|pgadmin/, Icon: Database, color: '#3b82f6' },
  { match: /mysql|maria/, Icon: Database, color: '#fb923c' },
  { match: /nginx|caddy|traefik|httpd|apache/, Icon: Server, color: '#22c55e' },
  { match: /node|bun|deno/, Icon: Hexagon, color: '#22c55e' },
  { match: /rabbit|kafka|nats/, Icon: Send, color: '#fb923c' },
  { match: /mail|smtp/, Icon: Mail, color: '#eab308' },
  { match: /adminer|phppgadmin|phpmyadmin|table/, Icon: Table2, color: '#3b82f6' },
  { match: /elastic|opensearch|search/, Icon: Search, color: '#eab308' },
  { match: /soketi|socket|ws|pusher|mqtt/, Icon: Globe, color: '#a78bfa' },
];

/** Mapeia uma imagem Docker pra um ícone+cor. Fallback: cubo com cor por hash. */
export function dockerImageIcon(image: string): { Icon: LucideIcon; color: string } {
  const i = image.toLowerCase();
  for (const m of MAP) if (m.match.test(i)) return { Icon: m.Icon, color: m.color };
  return { Icon: Box, color: hashColor(i) };
}
