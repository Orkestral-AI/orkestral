import type { AdapterConfigField, AdapterConfigSchema } from '@shared/types';
import { FolderOpen } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { Input } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';
import { Textarea } from '@renderer/components/ui/textarea';

interface AdapterConfigFieldsProps {
  schema: AdapterConfigSchema | undefined;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Passa pro DSSelect a variante de cor do onboarding (popover arroxeado). */
  onboarding?: boolean;
}

/**
 * Renderiza dinamicamente os campos de configuração de um adapter a partir do
 * seu configSchema. Os campos MUDAM quando o provedor (adapter) muda — esse é
 * o ponto. Usa os primitivos de UI da app (DsSelect, Input, Switch, Textarea).
 */
export function AdapterConfigFields({
  schema,
  value,
  onChange,
  onboarding,
}: AdapterConfigFieldsProps) {
  const { t } = useT();
  if (!schema || schema.fields.length === 0) return null;

  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  const current = (field: AdapterConfigField): unknown =>
    value[field.key] !== undefined ? value[field.key] : field.default;

  return (
    <div className="flex flex-col gap-3.5">
      {schema.fields.map((field) => {
        const val = current(field);
        const fieldId = `acf-${field.key}`;
        const labelText = `${field.label}${field.required ? ' *' : ''}`;

        if (field.type === 'toggle') {
          return (
            <div key={field.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={fieldId} className="text-[12.5px] text-text-secondary">
                  {labelText}
                </label>
                <Switch
                  id={fieldId}
                  checked={Boolean(val)}
                  onCheckedChange={(checked) => set(field.key, checked)}
                  aria-label={field.label}
                />
              </div>
              {field.hint && (
                <span className="text-[11px] leading-snug text-text-muted">{field.hint}</span>
              )}
            </div>
          );
        }

        return (
          <div key={field.key} className="flex flex-col gap-1.5">
            <label htmlFor={fieldId} className="text-[12.5px] text-text-secondary">
              {labelText}
            </label>

            {field.type === 'select' && (
              <DSSelect
                value={(val as string) ?? ''}
                onChange={(v) => set(field.key, v)}
                options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
                placeholder={field.placeholder}
                onboarding={onboarding}
              />
            )}

            {field.type === 'file' && (
              <div className="flex items-center gap-2">
                <Input
                  id={fieldId}
                  type="text"
                  value={(val as string) ?? ''}
                  placeholder={field.placeholder}
                  onChange={(e) => set(field.key, e.target.value)}
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const res = await window.orkestral['dialog:open-file']({
                      title: field.label,
                      filters: [
                        {
                          name: t('agents.adapterFields.fileFilters.markdownText'),
                          extensions: ['md', 'markdown', 'txt'],
                        },
                        { name: t('agents.adapterFields.fileFilters.allFiles'), extensions: ['*'] },
                      ],
                    });
                    if (res?.path) set(field.key, res.path);
                  }}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  title={t('agents.adapterFields.chooseFileTitle')}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('agents.adapterFields.chooseFile')}
                </button>
              </div>
            )}

            {field.type === 'textarea' && (
              <Textarea
                id={fieldId}
                value={(val as string) ?? ''}
                placeholder={field.placeholder}
                onChange={(e) => set(field.key, e.target.value)}
              />
            )}

            {(field.type === 'text' || field.type === 'password' || field.type === 'number') && (
              <Input
                id={fieldId}
                type={
                  field.type === 'password'
                    ? 'password'
                    : field.type === 'number'
                      ? 'number'
                      : 'text'
                }
                value={(val as string | number | undefined) ?? ''}
                placeholder={field.placeholder}
                onChange={(e) =>
                  set(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)
                }
              />
            )}

            {field.hint && (
              <span className="text-[11px] leading-snug text-text-muted">{field.hint}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default AdapterConfigFields;
