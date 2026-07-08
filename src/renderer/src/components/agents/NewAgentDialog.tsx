import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { ComboSelect } from '@renderer/components/ui/combo-select';
import { ProviderIcon } from '@renderer/components/ProviderIcon';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { cn } from '@renderer/lib/utils';
import { useT, type TFunction } from '@renderer/i18n';
import { AdapterConfigFields } from './AdapterConfigFields';
import { AvatarPicker } from './AvatarPicker';
import { AgentAvatar, seedFromName } from './AgentAvatar';
import type { AdapterTestResult, AdapterType } from '@shared/types';

interface NewAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (agentId: string) => void;
}

type Mode = 'ask-ceo' | 'advanced';

/**
 * Modal de criação de agente — segue o padrão Paperclip:
 *
 *  1. Modo "Ask CEO" (default): user descreve o agente que quer + missão.
 *     Cria uma sessão com o CEO/Orchestrator e manda ele criar. UX guiada.
 *
 *  2. Modo "Avançado": formulário completo com todos os parâmetros do
 *     paperclip (adapter, comando, modelo, cheap model, thinking effort,
 *     skip permissions, max turns, extra args, env vars, reports to, etc.)
 */
export function NewAgentDialog({ open, onOpenChange, onCreated }: NewAgentDialogProps) {
  const { t } = useT();
  const [mode, setMode] = useState<Mode>('ask-ceo');

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) setMode('ask-ceo');
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-full max-w-[560px] p-0">
        <div className="border-b border-hairline-faint px-6 py-5">
          <DialogTitle>{t('agents.newDialog.title')}</DialogTitle>
          <DialogDescription className="mt-1">
            {mode === 'ask-ceo'
              ? t('agents.newDialog.descriptionAskCeo')
              : t('agents.newDialog.descriptionAdvanced')}
          </DialogDescription>
        </div>

        {mode === 'ask-ceo' ? (
          <AskCEOForm
            onClose={() => onOpenChange(false)}
            onAdvanced={() => setMode('advanced')}
            onCreated={onCreated}
          />
        ) : (
          <AdvancedForm
            onClose={() => onOpenChange(false)}
            onBack={() => setMode('ask-ceo')}
            onCreated={onCreated}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Modo 1 — Ask CEO
// ============================================================================
function AskCEOForm({
  onClose,
  onAdvanced,
  onCreated,
}: {
  onClose: () => void;
  onAdvanced: () => void;
  onCreated?: (agentId: string) => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const workspace = useWorkspaceStore((s) => s.active);

  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Busca CEO/Orchestrator do workspace
  const agentsQuery = useQuery({
    queryKey: ['agents', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspace!.id }),
  });
  const ceoAgent = (agentsQuery.data ?? []).find((a) => a.isOrchestrator);

  const askMutation = useMutation({
    mutationFn: async () => {
      if (!workspace) throw new Error(t('agents.newDialog.askCeo.errors.workspaceUndefined'));
      if (!ceoAgent) throw new Error(t('agents.newDialog.askCeo.errors.ceoNotFound'));
      if (!name.trim()) throw new Error(t('agents.newDialog.askCeo.errors.nameRequired'));

      const prompt = buildAskCEOPrompt(t, name.trim(), mission.trim());
      const result = await window.orkestral['session:create']({
        workspaceId: workspace.id,
        agentId: ceoAgent.id,
        title: t('agents.newDialog.askCeo.sessionTitle', { name: name.trim() }),
        firstMessage: prompt,
      });
      return result;
    },
    onSuccess: ({ session }) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onClose();
      // HashRouter — navega sem precisar do Router context (a modal vive
      // fora do <Router> porque é global no App.tsx).
      window.location.hash = `#/session/${session.id}`;
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-5 px-6 py-5">
        <Field label={t('agents.newDialog.askCeo.nameLabel')}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('agents.newDialog.askCeo.namePlaceholder')}
            className="h-10 rounded-md bg-surface-subtle border-hairline-med"
          />
        </Field>

        <Field
          label={t('agents.newDialog.askCeo.missionLabel')}
          hint={t('agents.newDialog.askCeo.missionHint')}
        >
          <textarea
            value={mission}
            onChange={(e) => setMission(e.target.value)}
            rows={4}
            placeholder={t('agents.newDialog.askCeo.missionPlaceholder')}
            className="w-full resize-none rounded-md border border-hairline-med bg-surface-subtle px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-white/20"
          />
        </Field>

        {!ceoAgent && (
          <div className="flex items-start gap-2 rounded-md border border-accent-yellow/30 bg-accent-yellow/10 px-3 py-2.5 text-[12px] text-text-primary">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-yellow" />
            <div>{t('agents.newDialog.askCeo.noCeoWarning')}</div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2.5 text-[12px] text-text-primary">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
            <div>{error}</div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-hairline-faint px-6 py-4">
        <button
          type="button"
          onClick={() => askMutation.mutate()}
          disabled={askMutation.isPending || !name.trim() || !ceoAgent}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-text-primary px-4 text-[13px] font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {askMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('agents.newDialog.askCeo.talkingToCeo')}
            </>
          ) : (
            <>
              <Bot className="h-4 w-4" />
              {t('agents.newDialog.askCeo.askCeoCreate')}
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onAdvanced}
          className="text-center text-[12px] text-text-muted underline-offset-2 transition-colors hover:text-text-primary hover:underline"
        >
          {t('agents.newDialog.askCeo.configureManually')}
        </button>
      </div>

      <input type="hidden" data-on-created={onCreated ? '1' : '0'} />
    </div>
  );
}

function buildAskCEOPrompt(t: TFunction, name: string, mission: string): string {
  const parts = [t('agents.newDialog.askCeo.prompt.intro', { name })];
  if (mission) {
    parts.push(t('agents.newDialog.askCeo.prompt.mission', { mission }));
  }
  parts.push(t('agents.newDialog.askCeo.prompt.instructions'));
  return parts.join('\n\n');
}

// ============================================================================
// Modo 2 — Avançado (estilo Paperclip)
// ============================================================================
type ThinkingEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high';

function AdvancedForm({
  onClose,
  onBack,
  onCreated,
}: {
  onClose: () => void;
  onBack: () => void;
  onCreated?: (agentId: string) => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const workspace = useWorkspaceStore((s) => s.active);

  // --- Form state ---
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [parentAgentId, setParentAgentId] = useState<string | null>(null);

  const [adapterType, setAdapterType] = useState<AdapterType>('claude_local');
  // Config dinâmico específico do provedor (variant, thinking, sandbox, repoUrl,
  // url do gateway, etc.) — os campos mudam quando o adapter muda.
  const [dynamicConfig, setDynamicConfig] = useState<Record<string, unknown>>({});
  const [command, setCommand] = useState('');
  const [model, setModel] = useState('default');
  const [cheapModelEnabled, setCheapModelEnabled] = useState(false);
  const [cheapModel, setCheapModel] = useState('default');
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>('auto');
  const [enableChrome, setEnableChrome] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(true);
  const [maxTurns, setMaxTurns] = useState(1000);
  const [instructionsFile, setInstructionsFile] = useState('');
  const [extraArgs, setExtraArgs] = useState('');
  const [envVars, setEnvVars] = useState<
    Array<{ key: string; type: 'plain' | 'secret'; value: string }>
  >([]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [canEditFiles, setCanEditFiles] = useState(true);
  const [canRunCommands, setCanRunCommands] = useState(false);
  const [canCreateAgents, setCanCreateAgents] = useState(false);
  const [canAssignTasks, setCanAssignTasks] = useState(false);
  const [heartbeat, setHeartbeat] = useState(false);
  // Avatar — null durante criação significa "deriva do nome". Quando usuário
  // escolhe explicitamente no picker, vira string e persiste assim no DB.
  const [avatarSeed, setAvatarSeed] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AdapterTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: ['agents', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspace!.id }),
  });
  const otherAgents = agentsQuery.data ?? [];

  const adaptersQuery = useQuery({
    queryKey: ['adapters'],
    queryFn: () => window.orkestral['adapter:list'](),
  });
  const adapters = adaptersQuery.data ?? [];
  const selectedAdapter = adapters.find((a) => a.type === adapterType);

  const modelsQuery = useQuery({
    queryKey: ['adapter-models', adapterType],
    queryFn: () => window.orkestral['adapter:list-models']({ type: adapterType }),
  });
  const models = modelsQuery.data ?? [];
  const effectiveModel =
    models.length > 0 && !models.find((m) => m.id === model) ? (models[0]?.id ?? 'default') : model;

  function handleAdapterTypeChange(value: string): void {
    setAdapterType(value as AdapterType);
    setDynamicConfig({});
    setModel('default');
    setTestResult(null);
  }

  // Monta o adapterConfig: campos dinâmicos do provedor + campos dedicados do
  // form. Lido em runtime pelos adapters na hora de montar os args do CLI.
  function buildAdapterConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = { ...dynamicConfig };
    if (command.trim()) cfg.command = command.trim();
    if (thinkingEffort && thinkingEffort !== 'auto') {
      // claude usa `effort`; codex usa `modelReasoningEffort`.
      if (adapterType === 'codex_local') cfg.modelReasoningEffort = thinkingEffort;
      else cfg.effort = thinkingEffort;
    }
    if (enableChrome) cfg.chrome = true;
    if (instructionsFile.trim()) cfg.instructionsFilePath = instructionsFile.trim();
    const extra = extraArgs
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (extra.length) cfg.extraArgs = extra;
    return cfg;
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!workspace) throw new Error(t('agents.newDialog.advanced.errors.workspaceUndefined'));
      if (!name.trim()) throw new Error(t('agents.newDialog.advanced.errors.nameRequired'));
      return window.orkestral['agent:create']({
        workspaceId: workspace.id,
        name: name.trim(),
        title: title.trim() || undefined,
        role: 'specialist',
        adapterType,
        model: effectiveModel === 'default' ? undefined : effectiveModel,
        adapterConfig: buildAdapterConfig(),
        systemPrompt: systemPrompt.trim() || undefined,
        avatarSeed,
        canEditFiles,
        canRunCommands,
        canCreateAgents,
        canAssignTasks,
        // Tudo isso vai pra adapter_config como JSON estendido (alinhado com paperclip)
        // — campos não-críticos não merecem coluna própria.
      });
    },
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      onClose();
      onCreated?.(agent.id);
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.orkestral['adapter:test']({ type: adapterType });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        status: 'fail',
        message: err instanceof Error ? err.message : t('agents.newDialog.advanced.unknownError'),
        checks: [],
        durationMs: 0,
      });
    } finally {
      setTesting(false);
    }
  }

  function addEnvVar() {
    setEnvVars([...envVars, { key: '', type: 'plain', value: '' }]);
  }
  function updateEnvVar(i: number, patch: Partial<(typeof envVars)[number]>) {
    setEnvVars(envVars.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }
  function removeEnvVar(i: number) {
    setEnvVars(envVars.filter((_, idx) => idx !== i));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 px-6 py-5">
          {/* Avatar picker + Name/title lado a lado. O picker mostra o avatar
              derivado do nome digitado até o usuário escolher um explicitamente. */}
          <div className="flex items-stretch gap-3">
            <AvatarPicker
              seed={avatarSeed ?? (name.trim() ? seedFromName(name) : null)}
              name={name || 'Agent'}
              size={80}
              onChange={(seed) => setAvatarSeed(seed)}
            />
            <div className="flex flex-1 flex-col gap-2">
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('agents.newDialog.advanced.namePlaceholder')}
                className="h-9 rounded-md bg-surface-subtle border-hairline-med text-[13.5px]"
              />
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('agents.newDialog.advanced.titlePlaceholder')}
                className="h-9 rounded-md bg-surface-subtle border-hairline-med text-[13.5px]"
              />
            </div>
          </div>

          {/* Pílulas de metadata — General (read-only label) + Reports to (popover) */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-med bg-surface-faint px-2.5 text-[12px] text-text-secondary">
              <Wrench className="h-3 w-3" />
              {t('agents.newDialog.advanced.general')}
            </div>
            <ReportsToPill
              currentId={parentAgentId}
              onChange={setParentAgentId}
              agents={otherAgents}
            />
          </div>

          {/* Adapter */}
          <section className="flex flex-col gap-3">
            <SectionHeader>{t('agents.newDialog.advanced.adapter')}</SectionHeader>
            <Field label={t('agents.newDialog.advanced.adapterType')}>
              <ComboSelect
                value={adapterType}
                onChange={handleAdapterTypeChange}
                searchPlaceholder={t('agents.newDialog.advanced.adapterSearch')}
                options={adapters.map((a) => ({
                  value: a.type,
                  label: a.comingSoon
                    ? `${a.name} ${t('agents.newDialog.advanced.comingSoon')}`
                    : a.name,
                  keywords: a.name,
                  icon: <ProviderIcon provider={a.type} className="h-4 w-4 text-text-secondary" />,
                }))}
              />
            </Field>

            <SectionHeader subtitle>
              {t('agents.newDialog.advanced.permissionsConfig')}
            </SectionHeader>
            <Field
              label={t('agents.newDialog.advanced.command')}
              hint={t('agents.newDialog.advanced.commandHint')}
            >
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="claude"
                className="h-10 rounded-md bg-surface-subtle border-hairline-med font-mono text-[12.5px]"
              />
            </Field>

            {/* Opções específicas do provedor — campos dinâmicos que mudam
                    quando o adapter muda. Filtra os já cobertos por campos
                    dedicados acima (command/effort/chrome/instructions). */}
            {selectedAdapter?.configSchema &&
              (() => {
                const dyn = selectedAdapter.configSchema.fields.filter(
                  (f) =>
                    ![
                      'command',
                      'effort',
                      'modelReasoningEffort',
                      'chrome',
                      'instructionsFilePath',
                    ].includes(f.key),
                );
                if (dyn.length === 0) return null;
                return (
                  <Field label={t('agents.newDialog.advanced.providerOptions')}>
                    <AdapterConfigFields
                      schema={{ fields: dyn }}
                      value={dynamicConfig}
                      onChange={setDynamicConfig}
                    />
                  </Field>
                );
              })()}
          </section>

          {/* Primary Model */}
          <section className="flex flex-col gap-3">
            <SectionHeader>{t('agents.newDialog.advanced.primaryModel')}</SectionHeader>
            <Field label={t('agents.newDialog.advanced.model')}>
              <ModelDropdown
                value={effectiveModel}
                models={models.map((m) => ({ id: m.id, label: m.label }))}
                onChange={setModel}
              />
            </Field>

            {/* Cheap model toggle + select condicional */}
            <div className="flex flex-col gap-2 rounded-lg border border-hairline-med bg-surface-veil p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="text-[11.5px] font-medium uppercase tracking-[0.12em] text-text-faint">
                    {t('agents.newDialog.advanced.cheapModel')}
                  </div>
                  <div className="mt-1 text-[11.5px] text-text-muted">
                    {t('agents.newDialog.advanced.cheapModelHint')}
                  </div>
                </div>
                <Toggle value={cheapModelEnabled} onChange={setCheapModelEnabled} />
              </div>
              {cheapModelEnabled && (
                <ModelDropdown
                  value={cheapModel}
                  models={models.map((m) => ({ id: m.id, label: m.label }))}
                  onChange={setCheapModel}
                />
              )}
            </div>

            <Field label={t('agents.newDialog.advanced.thinkingEffort')}>
              <div className="relative">
                <select
                  value={thinkingEffort}
                  onChange={(e) => setThinkingEffort(e.target.value as ThinkingEffort)}
                  className="h-10 w-full appearance-none rounded-md border border-hairline-med bg-surface-subtle px-3 pr-9 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-white/20"
                >
                  <option value="auto" className="bg-surface">
                    {t('agents.newDialog.advanced.effort.auto')}
                  </option>
                  <option value="minimal" className="bg-surface">
                    {t('agents.newDialog.advanced.effort.minimal')}
                  </option>
                  <option value="low" className="bg-surface">
                    {t('agents.newDialog.advanced.effort.low')}
                  </option>
                  <option value="medium" className="bg-surface">
                    {t('agents.newDialog.advanced.effort.medium')}
                  </option>
                  <option value="high" className="bg-surface">
                    {t('agents.newDialog.advanced.effort.high')}
                  </option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
              </div>
            </Field>

            <ToggleRow
              label={t('agents.newDialog.advanced.enableChrome')}
              hint={t('agents.newDialog.advanced.enableChromeHint')}
              value={enableChrome}
              onChange={setEnableChrome}
            />
            <ToggleRow
              label={t('agents.newDialog.advanced.skipPermissions')}
              hint={t('agents.newDialog.advanced.skipPermissionsHint')}
              value={skipPermissions}
              onChange={setSkipPermissions}
            />

            <Field label={t('agents.newDialog.advanced.maxTurns')}>
              <Input
                type="number"
                value={maxTurns}
                onChange={(e) => setMaxTurns(Number(e.target.value) || 0)}
                className="h-10 rounded-md bg-surface-subtle border-hairline-med"
              />
            </Field>

            <Field
              label={t('agents.newDialog.advanced.instructionsFile')}
              hint={t('agents.newDialog.advanced.instructionsFileHint')}
            >
              <div className="flex gap-2">
                <Input
                  value={instructionsFile}
                  onChange={(e) => setInstructionsFile(e.target.value)}
                  placeholder="/absolute/path/to/AGENTS.md"
                  className="h-10 flex-1 rounded-md bg-surface-subtle border-hairline-med font-mono text-[12px]"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const r = await window.orkestral['dialog:open-directory']({
                      title: t('agents.newDialog.advanced.instructionsDirTitle'),
                    });
                    if (r?.path) setInstructionsFile(r.path);
                  }}
                  className="inline-flex h-10 items-center rounded-md border border-hairline-med bg-surface-subtle px-3 text-[12.5px] text-text-primary transition-colors hover:bg-surface-1"
                >
                  {t('common.choose')}
                </button>
              </div>
            </Field>

            <Field
              label={t('agents.newDialog.advanced.extraArgs')}
              hint={t('agents.newDialog.advanced.extraArgsHint')}
            >
              <Input
                value={extraArgs}
                onChange={(e) => setExtraArgs(e.target.value)}
                placeholder={t('agents.newDialog.advanced.extraArgsPlaceholder')}
                className="h-10 rounded-md bg-surface-subtle border-hairline-med font-mono text-[12px]"
              />
            </Field>

            <Field
              label={t('agents.newDialog.advanced.envVars')}
              hint={t('agents.newDialog.advanced.envVarsHint')}
            >
              <div className="flex flex-col gap-2">
                {envVars.map((v, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={v.key}
                      onChange={(e) => updateEnvVar(i, { key: e.target.value })}
                      placeholder="KEY"
                      className="h-9 flex-1 rounded-md bg-surface-subtle border-hairline-med font-mono text-[12px]"
                    />
                    <select
                      value={v.type}
                      onChange={(e) =>
                        updateEnvVar(i, { type: e.target.value as 'plain' | 'secret' })
                      }
                      className="h-9 appearance-none rounded-md border border-hairline-med bg-surface-subtle px-2 text-[12px] text-text-primary focus:outline-none"
                    >
                      <option value="plain" className="bg-surface">
                        {t('agents.newDialog.advanced.envType.plain')}
                      </option>
                      <option value="secret" className="bg-surface">
                        {t('agents.newDialog.advanced.envType.secret')}
                      </option>
                    </select>
                    <Input
                      value={v.value}
                      onChange={(e) => updateEnvVar(i, { value: e.target.value })}
                      placeholder="value"
                      type={v.type === 'secret' ? 'password' : 'text'}
                      className="h-9 flex-[2] rounded-md bg-surface-subtle border-hairline-med font-mono text-[12px]"
                    />
                    <button
                      type="button"
                      onClick={() => removeEnvVar(i)}
                      className="grid h-9 w-9 place-items-center rounded text-text-muted hover:bg-surface-1 hover:text-accent-red"
                      title={t('agents.newDialog.advanced.removeVar')}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addEnvVar}
                  className="inline-flex h-9 w-full items-center justify-center rounded-md border border-dashed border-hairline-strong text-[12px] text-text-secondary transition-colors hover:border-white/20 hover:text-text-primary"
                >
                  {t('agents.newDialog.advanced.addVar')}
                </button>
              </div>
            </Field>
          </section>

          {/* Run Policy */}
          <section className="flex flex-col gap-3">
            <SectionHeader>{t('agents.newDialog.advanced.runPolicy')}</SectionHeader>
            <ToggleRow
              label={t('agents.newDialog.advanced.heartbeatInterval')}
              hint={t('agents.newDialog.advanced.heartbeatIntervalHint')}
              value={heartbeat}
              onChange={setHeartbeat}
            />
          </section>

          {/* Capabilities */}
          <section className="flex flex-col gap-3">
            <SectionHeader>{t('agents.newDialog.advanced.capabilities')}</SectionHeader>
            <div className="flex flex-col gap-2 rounded-lg border border-hairline-med bg-surface-veil p-3">
              <ToggleRow
                label={t('agents.newDialog.advanced.capEditFiles')}
                value={canEditFiles}
                onChange={setCanEditFiles}
                inline
              />
              <ToggleRow
                label={t('agents.newDialog.advanced.capRunCommands')}
                value={canRunCommands}
                onChange={setCanRunCommands}
                inline
              />
              <ToggleRow
                label={t('agents.newDialog.advanced.capCreateAgents')}
                value={canCreateAgents}
                onChange={setCanCreateAgents}
                inline
              />
              <ToggleRow
                label={t('agents.newDialog.advanced.capAssignTasks')}
                value={canAssignTasks}
                onChange={setCanAssignTasks}
                inline
              />
            </div>
          </section>

          {/* System prompt */}
          <section className="flex flex-col gap-3">
            <SectionHeader>{t('agents.newDialog.advanced.systemPrompt')}</SectionHeader>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              placeholder={t('agents.newDialog.advanced.systemPromptPlaceholder')}
              className="w-full resize-none rounded-md border border-hairline-med bg-surface-subtle px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-white/20"
            />
          </section>

          {/* Test result */}
          {testResult && (
            <div className="rounded-lg border border-hairline-med bg-surface-veil p-3">
              <div className="flex items-center gap-2 text-[12px]">
                <TestStatus status={testResult.status} />
                <span className="text-text-primary">{testResult.message}</span>
              </div>
              {testResult.checks.map((c, i) => (
                <div key={i} className="mt-2 flex items-start gap-2 text-[11px]">
                  <TestStatus status={c.status} small />
                  <div className="flex-1">
                    <div className="text-text-secondary">{c.label}</div>
                    {c.detail && (
                      <div className="mt-0.5 leading-snug text-text-muted">{c.detail}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2.5 text-[12px] text-text-primary">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
              <div>{error}</div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-hairline-faint px-6 py-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-9 items-center rounded-md px-3 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
        >
          {t('common.back')}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-hover px-3 text-[12.5px] font-medium text-text-primary transition-colors hover:bg-surface-active disabled:opacity-50"
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t('agents.newDialog.advanced.testAgent')}
          </button>
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || name.trim().length === 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-text-primary px-4 text-[13px] font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('agents.newDialog.advanced.creating')}
              </>
            ) : (
              t('agents.newDialog.advanced.createAgent')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================
/**
 * Pílula "Reports to..." — abre popover pra escolher o gerente (não troca
 * a tela; é só metadata informativa, igual ao paperclip). Quando setado, o
 * agente terá que validar com esse manager antes de aplicar mudanças.
 */
function ReportsToPill({
  currentId,
  onChange,
  agents,
}: {
  currentId: string | null;
  onChange: (id: string | null) => void;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    isOrchestrator: boolean;
    avatarSeed?: string | null;
  }>;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const current = currentId ? agents.find((a) => a.id === currentId) : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-all',
          current
            ? 'border-white/15 bg-surface-2 text-text-primary'
            : 'border-hairline-med bg-surface-faint text-text-secondary hover:bg-surface-1 hover:text-text-primary',
        )}
        title={t('agents.newDialog.reportsTo.title')}
      >
        {current ? (
          <AgentAvatar seed={current.avatarSeed} name={current.name} size={12} />
        ) : (
          <Bot className="h-3 w-3" />
        )}
        {t('agents.newDialog.reportsTo.label')}
        {current && <span className="text-text-muted">· {current.name}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1.5 w-[280px] overflow-hidden rounded-lg border border-hairline-strong bg-dialog shadow-2xl">
            <div className="border-b border-hairline-faint px-3 py-2 text-[10.5px] font-medium uppercase tracking-[0.18em] text-text-faint">
              {t('agents.newDialog.reportsTo.header')}
            </div>
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2',
                currentId === null && 'bg-surface-1',
              )}
            >
              <span className="grid h-5 w-5 place-items-center rounded-md border border-dashed border-hairline-heavy text-text-faint">
                <XCircle className="h-3 w-3" />
              </span>
              <div className="flex-1 text-[12.5px] text-text-primary">
                {t('agents.newDialog.reportsTo.noManager')}
              </div>
              {currentId === null && <CheckCircle2 className="h-3.5 w-3.5 text-accent-green" />}
            </button>
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onChange(a.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 border-t border-hairline-soft px-3 py-2.5 text-left transition-colors hover:bg-surface-2',
                  currentId === a.id && 'bg-surface-1',
                )}
              >
                <AgentAvatar
                  seed={a.avatarSeed}
                  name={a.name}
                  size={20}
                  rounded="md"
                  className="ring-0"
                />
                <div className="flex-1">
                  <div className="text-[12.5px] font-medium text-text-primary">{a.name}</div>
                  <div className="text-[10.5px] text-text-muted">
                    {a.isOrchestrator ? t('agents.newDialog.reportsTo.ceoRole') : a.role}
                  </div>
                </div>
                {currentId === a.id && <CheckCircle2 className="h-3.5 w-3.5 text-accent-green" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SectionHeader({ children, subtitle }: { children: React.ReactNode; subtitle?: boolean }) {
  if (subtitle) {
    return <div className="text-[12px] text-text-secondary">{children}</div>;
  }
  return <div className="text-[13px] font-medium text-text-primary">{children}</div>;
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn(
        'flex h-4 w-7 shrink-0 items-center rounded-full border border-hairline-strong p-0.5 transition-colors',
        value ? 'bg-accent-green/25' : 'bg-surface-1',
      )}
    >
      <span
        className={cn(
          'h-3 w-3 rounded-full transition-all',
          value ? 'translate-x-3 bg-accent-green' : 'translate-x-0 bg-white/30',
        )}
      />
    </button>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  inline,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  inline?: boolean;
}) {
  if (inline) {
    return (
      <button
        type="button"
        onClick={() => onChange(!value)}
        className="flex items-center justify-between gap-3 rounded px-1.5 py-1 text-left transition-colors hover:bg-surface-1"
      >
        <span className="text-[12.5px] text-text-primary">{label}</span>
        <Toggle value={value} onChange={onChange} />
      </button>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-hairline-med bg-surface-veil p-3">
      <div className="flex-1">
        <div className="text-[12.5px] font-medium text-text-primary">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-text-muted">{hint}</div>}
      </div>
      <Toggle value={value} onChange={onChange} />
    </div>
  );
}

function ModelDropdown({
  value,
  models,
  onChange,
}: {
  value: string;
  models: Array<{ id: string; label: string }>;
  onChange: (id: string) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full appearance-none rounded-md border border-hairline-med bg-surface-subtle px-3 pr-9 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-white/20"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id} className="bg-surface">
            {m.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
    </div>
  );
}

function TestStatus({ status, small }: { status: AdapterTestResult['status']; small?: boolean }) {
  const size = small ? 'h-3 w-3' : 'h-3.5 w-3.5';
  if (status === 'pass') return <CheckCircle2 className={cn(size, 'shrink-0 text-accent-green')} />;
  if (status === 'warn') return <AlertCircle className={cn(size, 'shrink-0 text-accent-yellow')} />;
  return <XCircle className={cn(size, 'shrink-0 text-accent-red')} />;
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label className="text-[11.5px] font-medium uppercase tracking-[0.12em] text-text-faint">
        {label}
      </label>
      {children}
      {hint && <div className="text-[10.5px] text-text-muted">{hint}</div>}
    </div>
  );
}
