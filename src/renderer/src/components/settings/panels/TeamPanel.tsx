import { useQuery } from '@tanstack/react-query';
import { Cloud, Sparkles, UserRound, Users } from 'lucide-react';
import { Input } from '@renderer/components/ui/input';
import { Button } from '@renderer/components/ui/button';
import { PanelShell } from './PanelShell';
import { usePlan } from '@renderer/hooks/usePlan';
import { useT } from '@renderer/i18n';

/**
 * Equipe — HONESTO. Sem humanos falsos, sem seats fictícios.
 *
 * O único humano real é o próprio usuário (user:get). Agentes de IA são
 * gerenciados na sidebar/Agentes — aqui é só pra colegas HUMANOS. Convites
 * dependem do Orkestral Cloud (ainda não existe), então mostramos o estado
 * "em breve" com o convite desabilitado. usePlan() é a fonte única: se algum
 * dia for team-cloud, é aqui que os membros reais apareceriam.
 */
export function TeamPanel() {
  const { t } = useT();
  const { isLocal } = usePlan();
  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: () => window.orkestral['user:get'](),
  });
  const user = userQuery.data ?? null;

  return (
    <PanelShell
      icon={Users}
      title={t('settings.team.title')}
      description={t('settings.team.description')}
    >
      {/* Membro real: você */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
        <div className="flex items-center gap-3 px-3.5 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-purple/12 text-accent-purple">
            <UserRound className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-primary">
              {user?.name?.trim() || t('settings.team.you')}
            </div>
            {user?.email && (
              <div className="truncate text-[11.5px] text-text-muted">{user.email}</div>
            )}
          </div>
          <span className="inline-flex shrink-0 items-center rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-muted">
            {t('settings.team.youOwner')}
          </span>
        </div>
      </div>

      <p className="-mt-2 text-[11px] leading-relaxed text-text-faint">
        {t('settings.team.agentsNote')}
      </p>

      {/* Convite — em breve (depende do Cloud) */}
      <div className="rounded-lg border border-dashed border-border bg-surface/30 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-secondary">
            <Cloud className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-text-primary">
                {t('settings.team.inviteTitle')}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-muted">
                <Sparkles className="h-2.5 w-2.5" />
                {t('common.comingSoon')}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {isLocal ? t('settings.team.inviteLocalBlurb') : t('settings.team.inviteTeamBlurb')}
            </p>
            <div className="mt-3 flex gap-2">
              <Input
                type="email"
                placeholder={t('settings.team.invitePlaceholder')}
                disabled
                className="h-8 flex-1"
              />
              <Button
                variant="secondary"
                size="sm"
                disabled
                title={t('settings.team.inviteButtonTitle')}
              >
                {t('settings.team.inviteButton')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </PanelShell>
  );
}
