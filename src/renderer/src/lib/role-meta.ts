import { BookOpen, Box, Cloud, Monitor, Server, Smartphone } from 'lucide-react';
import type { WorkspaceSourceRole } from '@shared/types';

/**
 * Metadados visuais por role de source. Usado no role-picker, sidebar,
 * filtros e qualquer outro lugar que precise apresentar role.
 */
export const ROLE_META: Record<
  WorkspaceSourceRole,
  { label: string; icon: typeof Monitor; color: string; chip: string }
> = {
  frontend: {
    label: 'Frontend',
    icon: Monitor,
    color: 'text-accent-blue',
    chip: 'text-accent-blue bg-accent-blue/10 border-accent-blue/25',
  },
  backend: {
    label: 'Backend',
    icon: Server,
    color: 'text-accent-green',
    chip: 'text-accent-green bg-accent-green/10 border-accent-green/25',
  },
  mobile: {
    label: 'Mobile',
    icon: Smartphone,
    color: 'text-accent-purple',
    chip: 'text-accent-purple bg-accent-purple/10 border-accent-purple/25',
  },
  infra: {
    label: 'Infra',
    icon: Cloud,
    color: 'text-accent-yellow',
    chip: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/25',
  },
  docs: {
    label: 'Docs',
    icon: BookOpen,
    color: 'text-text-secondary',
    chip: 'text-text-secondary bg-white/[0.04] border-white/[0.08]',
  },
  other: {
    label: 'Outro',
    icon: Box,
    color: 'text-text-muted',
    chip: 'text-text-muted bg-white/[0.04] border-white/[0.08]',
  },
};

export const ROLE_ORDER: WorkspaceSourceRole[] = [
  'frontend',
  'backend',
  'mobile',
  'infra',
  'docs',
  'other',
];
