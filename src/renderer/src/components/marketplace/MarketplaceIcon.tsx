import { useState } from 'react';
import {
  BookOpen,
  Brain,
  Network,
  FolderTree,
  Github,
  Gitlab,
  Globe,
  Search,
  Database,
  CreditCard,
  Figma,
  Slack,
  MapPin,
  FileText,
  Terminal,
  Bot,
  Boxes,
  ScrollText,
  FlaskConical,
  GitCommitHorizontal,
  GitPullRequestArrow,
  ShieldCheck,
  Bug,
  Wrench,
  Sparkles,
  Zap,
  Server,
  Wand2,
  LayoutDashboard,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  BookOpen,
  Brain,
  Network,
  FolderTree,
  Github,
  Gitlab,
  Globe,
  Search,
  Database,
  CreditCard,
  Figma,
  Slack,
  MapPin,
  FileText,
  Terminal,
  Bot,
  Boxes,
  ScrollText,
  FlaskConical,
  GitCommitHorizontal,
  GitPullRequestArrow,
  ShieldCheck,
  Bug,
  Wrench,
  Sparkles,
  Zap,
  Server,
  Wand2,
  LayoutDashboard,
};

/**
 * Renderiza o logo de um item do marketplace. Prefere um logo remoto (`src`,
 * ex: avatar do GitHub) e cai pro ícone lucide do `iconKey` se a imagem falhar
 * ou não existir. Componente estável (resolução é só um lookup no mapa).
 */
export function MarketplaceIcon({
  iconKey,
  src,
  kind = 'mcp',
  className,
  imgClassName,
}: {
  iconKey?: string;
  src?: string;
  kind?: 'mcp' | 'skill';
  className?: string;
  imgClassName?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className={imgClassName ?? 'h-full w-full rounded-[5px] object-cover'}
      />
    );
  }
  const Icon = (iconKey && ICONS[iconKey]) || (kind === 'skill' ? Wand2 : Server);
  return <Icon className={className} />;
}
