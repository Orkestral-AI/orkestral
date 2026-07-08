import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Palette } from 'lucide-react';
import { Highlight } from 'prism-react-renderer';
import { cn } from '@renderer/lib/utils';
import { CODE_THEMES, type CodeThemePreset } from '@renderer/lib/codeThemes';
import type { CodeThemeId, Workspace } from '@shared/types';
import { PanelShell, Field, ToggleRow } from './PanelShell';
import { WorkspacePicker } from '@renderer/components/workspace/WorkspacePicker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { ACCENTS, accentTokenFromColor } from '@renderer/lib/accents';
import { useCodeTheme } from '@renderer/hooks/useCodeTheme';
import { useT } from '@renderer/i18n';
import type { SettingsRecord } from '@shared/types';

type Appearance = SettingsRecord['appearance'];

const THEMES: { id: Appearance['theme']; labelKey: string }[] = [
  { id: 'dark', labelKey: 'settings.appearance.themeDark' },
  { id: 'light', labelKey: 'settings.appearance.themeLight' },
  { id: 'system', labelKey: 'settings.appearance.themeSystem' },
];

// Nomes de idioma exibidos no próprio idioma (convenção). 'system' é traduzido.
const LANGUAGES: { id: Appearance['language']; label: string }[] = [
  { id: 'system', label: '' },
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'en', label: 'English' },
];

// Amostra multi-linha (estilo DevSenses) destacada com a prism do preset.
const SAMPLE_CODE = `function greet(name: string) {
  const msg = \`Hello, \${name}\`
  return msg.length
}`;

// Diff de exemplo: 1 linha adicionada (verde) + 1 removida (vermelho).
const SAMPLE_DIFF: { type: 'add' | 'del'; text: string }[] = [
  { type: 'add', text: 'const total = items.length' },
  { type: 'del', text: 'let total = 0' },
];

/**
 * Card de preview de um tema de código (estilo DevSenses): código multi-linha
 * destacado + um pequeno diff colorido com as cores do próprio tema.
 */
function CodeThemePreviewCard({
  preset,
  variant,
  selected,
  onSelect,
}: {
  preset: CodeThemePreset;
  variant: CodeThemePreset['dark'];
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const c = variant.colors;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'overflow-hidden rounded-lg border text-left transition-colors',
        selected
          ? 'border-accent-purple/60 ring-1 ring-accent-purple/40'
          : 'border-border hover:border-text-faint',
      )}
    >
      <div
        className="px-3 py-2.5 font-mono text-[10px] leading-[15px]"
        style={{ background: variant.prism.plain.backgroundColor, color: c.fg }}
      >
        <Highlight code={SAMPLE_CODE} language="tsx" theme={variant.prism}>
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre className="m-0 whitespace-pre">
              {tokens.map((line, i) => (
                <div key={i} {...getLineProps({ line })}>
                  <span style={{ color: c.lineNum, marginRight: 8, userSelect: 'none' }}>
                    {String(i + 1).padStart(2, ' ')}
                  </span>
                  {line.map((token, k) => (
                    <span key={k} {...getTokenProps({ token })} />
                  ))}
                </div>
              ))}
            </pre>
          )}
        </Highlight>

        <div className="mt-2 pt-2" style={{ borderTop: `1px solid ${c.border}` }}>
          {SAMPLE_DIFF.map((d, i) => {
            const bg = d.type === 'add' ? c.addBg : c.delBg;
            const sign = d.type === 'add' ? '+' : '-';
            const signColor = d.type === 'add' ? c.addFg : c.delFg;
            return (
              <div
                key={i}
                className="flex whitespace-pre"
                style={{ backgroundColor: bg, padding: '0 4px' }}
              >
                <span style={{ color: signColor, width: 12, userSelect: 'none' }}>{sign}</span>
                <Highlight code={d.text} language="tsx" theme={variant.prism}>
                  {({ tokens, getTokenProps }) => (
                    <span>
                      {tokens[0]?.map((token, k) => (
                        <span key={k} {...getTokenProps({ token })} />
                      ))}
                    </span>
                  )}
                </Highlight>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border bg-surface px-3 py-1.5">
        <span className="text-[12px] text-text-primary">{preset.label}</span>
        {selected && <Check className="h-3.5 w-3.5 text-accent-purple" />}
      </div>
    </button>
  );
}

export function AppearancePanel(): React.JSX.Element {
  const appearance = useSettingsStore((s) => s.settings?.appearance);
  const update = useSettingsStore((s) => s.updateAppearance);
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActive);
  const queryClient = useQueryClient();
  const { t } = useT();

  // Defaults seguros enquanto hidrata (evita controles "vazios" no primeiro frame).
  const theme = appearance?.theme ?? 'dark';
  const language = appearance?.language ?? 'system';
  const density = appearance?.density ?? 'comfortable';
  const fontSize = appearance?.fontSize ?? 'md';
  const codeTheme = appearance?.codeTheme ?? 'default';
  const { resolved } = useCodeTheme();

  // Workspace em edição: inicia no ativo, mas o picker permite recolorir outro
  // sem trocar o ativo global. Só o accent é por-workspace — tema/idioma/fonte
  // são globais e não seguem o picker.
  const [viewWs, setViewWs] = useState<Workspace | null>(activeWorkspace);
  useEffect(() => {
    if (!viewWs && activeWorkspace) setViewWs(activeWorkspace);
  }, [activeWorkspace, viewWs]);

  // Accent = cor do workspace em edição. O seletor edita a cor desse workspace.
  const accent = accentTokenFromColor(viewWs?.color);

  async function selectAccent(hex: string): Promise<void> {
    if (!viewWs) return;
    const updated = await window.orkestral['workspace:update']({
      workspaceId: viewWs.id,
      patch: { color: hex },
    });
    // Reflete a nova cor no objeto em edição (mostra o swatch certo).
    setViewWs(updated);
    // Só repinta a UI ao vivo se editamos o workspace ATIVO; recolorir outro
    // não deve mudar o accent da sessão atual.
    if (activeWorkspace?.id === updated.id) setActiveWorkspace(updated);
    queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  }

  return (
    <PanelShell
      icon={Palette}
      title={t('settings.appearance.title')}
      description={t('settings.appearance.description')}
    >
      <Tabs defaultValue="appearance" className="flex flex-col">
        <TabsList className="w-fit">
          <TabsTrigger value="appearance">{t('settings.appearance.tabAppearance')}</TabsTrigger>
          <TabsTrigger value="theme">{t('settings.appearance.tabTheme')}</TabsTrigger>
        </TabsList>

        <TabsContent value="appearance">
          <div className="flex flex-col" style={{ gap: 'var(--density-gap, 1.25rem)' }}>
            <Field
              label={t('settings.appearance.themeLabel')}
              description={t('settings.appearance.themeDescription')}
            >
              <div className="flex gap-2">
                {THEMES.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => void update({ theme: opt.id })}
                    className={cn(
                      'h-9 flex-1 rounded-md border px-3 text-[12.5px] transition-colors',
                      theme === opt.id
                        ? 'border-accent-purple/40 bg-accent-purple/10 text-text-primary'
                        : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary',
                    )}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label={t('settings.language.label')}
              description={t('settings.language.description')}
            >
              <div className="flex gap-2">
                {LANGUAGES.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => void update({ language: l.id })}
                    className={cn(
                      'h-9 flex-1 rounded-md border px-3 text-[12.5px] transition-colors',
                      language === l.id
                        ? 'border-accent-purple/40 bg-accent-purple/10 text-text-primary'
                        : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary',
                    )}
                  >
                    {l.id === 'system' ? t('settings.language.system') : l.label}
                  </button>
                ))}
              </div>
            </Field>

            {/* Seletor de workspace: recolore o escolhido sem trocar o ativo */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-text-muted">
                {t('settings.appearance.scopeLabel')}
              </span>
              <WorkspacePicker value={viewWs?.id} onChange={setViewWs} align="end" />
            </div>

            <Field
              label={t('settings.appearance.accentLabel')}
              description={
                viewWs
                  ? t('settings.appearance.accentDescription', { workspace: viewWs.name })
                  : t('settings.appearance.accentNoWorkspace')
              }
            >
              <div className="flex gap-3">
                {ACCENTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!viewWs}
                    onClick={() => void selectAccent(a.hex)}
                    aria-label={a.id}
                    className={cn(
                      'h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-[var(--color-surface)] transition-transform disabled:opacity-40',
                      accent === a.id
                        ? 'scale-110 ring-[var(--color-text-primary)]'
                        : 'ring-transparent hover:scale-105',
                    )}
                    style={{ backgroundColor: a.hex }}
                  />
                ))}
              </div>
            </Field>

            <ToggleRow
              label={t('settings.appearance.densityLabel')}
              description={t('settings.appearance.densityDescription')}
              right={
                <Select
                  value={density}
                  onValueChange={(v) => void update({ density: v as Appearance['density'] })}
                >
                  <SelectTrigger className="h-8 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="comfortable">
                      {t('settings.appearance.densityComfortable')}
                    </SelectItem>
                    <SelectItem value="compact">
                      {t('settings.appearance.densityCompact')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              }
            />

            <ToggleRow
              label={t('settings.appearance.fontSizeLabel')}
              description={t('settings.appearance.fontSizeDescription')}
              right={
                <Select
                  value={fontSize}
                  onValueChange={(v) => void update({ fontSize: v as Appearance['fontSize'] })}
                >
                  <SelectTrigger className="h-8 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sm">{t('settings.appearance.fontSizeSmall')}</SelectItem>
                    <SelectItem value="md">{t('settings.appearance.fontSizeMedium')}</SelectItem>
                    <SelectItem value="lg">{t('settings.appearance.fontSizeLarge')}</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
          </div>
        </TabsContent>

        <TabsContent value="theme">
          <Field
            label={t('settings.appearance.codeThemeLabel')}
            description={t('settings.appearance.codeThemeDescription')}
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {CODE_THEMES.map((preset) => {
                const variant = resolved === 'light' ? preset.light : preset.dark;
                const selected = codeTheme === preset.id;
                return (
                  <CodeThemePreviewCard
                    key={preset.id}
                    preset={preset}
                    variant={variant}
                    selected={selected}
                    onSelect={() => void update({ codeTheme: preset.id as CodeThemeId })}
                  />
                );
              })}
            </div>
          </Field>
        </TabsContent>
      </Tabs>
    </PanelShell>
  );
}
