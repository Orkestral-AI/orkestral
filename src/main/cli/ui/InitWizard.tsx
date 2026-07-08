import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { CompactTitle } from './Welcome';
import { ChannelConnect } from './ChannelConnect';
import { WorkspaceCreate } from './WorkspaceCreate';
import { TextPrompt } from './input/TextPrompt';
import { WorkspaceRepository } from '../../db/repositories/workspace.repo';
import { AgentRepository } from '../../db/repositories/agent.repo';
import { SettingsRepository } from '../../db/repositories/settings.repo';
import { createFirstAgent } from '../../ipc/handlers/onboarding';
import type { AdapterType } from '../../../shared/types';

/**
 * Wizard de setup do daemon headless (`orkestral init`): escolhe/cria workspace,
 * escolhe/cria agente (adapter + model) e conecta um canal (WhatsApp via QR no
 * terminal, ou Telegram/Discord via token). Persiste o workspace escolhido como
 * o ativo do daemon (SettingsRepository) pra o `serve`/`status` saberem qual usar.
 *
 * Tudo roda contra os repos/serviços reais — sem IPC, sem renderer. O QR do
 * WhatsApp é desenhado no próprio terminal (qrcode-terminal) e o passo de canal
 * espera o status virar `connected` fazendo polling do snapshot da conta.
 */

const ADAPTER_OPTIONS: { value: AdapterType; label: string }[] = [
  { value: 'claude_local', label: 'Claude (claude_local)' },
  { value: 'codex_local', label: 'Codex (codex_local)' },
];

type Step = 'workspace' | 'agent' | 'channel' | 'done';

interface SelectOption {
  label: string;
  value: string;
}

/** Lista navegável com setas + Enter. Sem deps externas (só useInput). */
function SelectList({
  options,
  onSelect,
}: {
  options: SelectOption[];
  onSelect: (value: string) => void;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + options.length) % options.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % options.length);
    else if (key.return) onSelect(options[index].value);
  });
  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Text key={opt.value} color={i === index ? '#a78bfa' : undefined}>
          {i === index ? '❯ ' : '  '}
          {opt.label}
        </Text>
      ))}
    </Box>
  );
}

/** Passo de workspace: escolher um existente ou criar (delega no WorkspaceCreate). */
function WorkspaceStep({ onDone }: { onDone: (workspaceId: string) => void }): React.ReactElement {
  const workspaceRepo = new WorkspaceRepository();
  const [existing] = useState(() => workspaceRepo.listAll());
  const [mode, setMode] = useState<'pick' | 'create'>(existing.length > 0 ? 'pick' : 'create');

  const persistAndDone = (id: string): void => {
    new SettingsRepository().setDaemonActiveWorkspaceId(id);
    onDone(id);
  };

  if (mode === 'pick') {
    const options: SelectOption[] = [
      ...existing.map((w) => ({ label: w.name, value: w.id })),
      { label: '+ criar novo workspace', value: '__new__' },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>1/3 · Workspace</Text>
        <Text dimColor>Escolha um workspace (↑↓ + Enter):</Text>
        <SelectList
          options={options}
          onSelect={(v) => (v === '__new__' ? setMode('create') : persistAndDone(v))}
        />
      </Box>
    );
  }

  // mode === 'create' — fluxo nome→pasta→create compartilhado com o REPL.
  return (
    <Box flexDirection="column">
      <Text bold>1/3 · Workspace</Text>
      <WorkspaceCreate
        onCreated={persistAndDone}
        onCancel={() => (existing.length > 0 ? setMode('pick') : undefined)}
      />
    </Box>
  );
}

/** Passo de agente: escolher um existente ou criar (nome + adapter + model).
 *  `onDone` recebe o id do agente ESCOLHIDO/CRIADO — o passo de canal usa esse
 *  agente (e não re-resolve o orquestrador por cima da escolha). */
function AgentStep({
  workspaceId,
  onDone,
}: {
  workspaceId: string;
  onDone: (agentId: string) => void;
}): React.ReactElement {
  const agentRepo = new AgentRepository();
  const [existing] = useState(() => agentRepo.listByWorkspace(workspaceId));
  const [hasOrchestrator] = useState(() => agentRepo.getOrchestrator(workspaceId) !== null);
  const [mode, setMode] = useState<'pick' | 'name' | 'adapter' | 'model'>(
    existing.length > 0 ? 'pick' : 'name',
  );
  const [name, setName] = useState('');
  const [adapter, setAdapter] = useState<AdapterType>('claude_local');

  const finishCreate = (model: string): void => {
    if (hasOrchestrator) {
      // Já existe orquestrador (o canal roteia pra ele); cria um especialista simples.
      const created = agentRepo.create({
        workspaceId,
        name,
        adapterType: adapter,
        model: model || undefined,
      });
      onDone(created.id);
      return;
    }
    // Primeiro agente do workspace → CEO/orquestrador completo (system prompt,
    // skills e instruções), igual ao onboarding. É o agente que o canal usa.
    const created = createFirstAgent({
      workspaceId,
      name,
      adapterType: adapter,
      model: model || undefined,
      adapterConfig: {},
    });
    onDone(created.id);
  };

  if (mode === 'pick') {
    const options: SelectOption[] = [
      ...existing.map((a) => ({
        label: `${a.name} · ${a.adapterType}${a.model ? ` · ${a.model}` : ''}`,
        value: a.id,
      })),
      { label: '+ criar novo agente', value: '__new__' },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>2/3 · Agente</Text>
        <Text dimColor>Escolha um agente (↑↓ + Enter):</Text>
        <SelectList
          options={options}
          onSelect={(v) => (v === '__new__' ? setMode('name') : onDone(v))}
        />
      </Box>
    );
  }

  if (mode === 'name') {
    return (
      <Box flexDirection="column">
        <Text bold>2/3 · Novo agente</Text>
        <TextPrompt
          key="agent-name"
          label="Nome do agente:"
          placeholder="Orquestrador"
          onSubmit={(v) => {
            if (!v) return;
            setName(v);
            setMode('adapter');
          }}
        />
      </Box>
    );
  }

  if (mode === 'adapter') {
    return (
      <Box flexDirection="column">
        <Text bold>2/3 · Novo agente</Text>
        <Text dimColor>Adapter (↑↓ + Enter):</Text>
        <SelectList
          options={ADAPTER_OPTIONS.map((a) => ({ label: a.label, value: a.value }))}
          onSelect={(v) => {
            setAdapter(v as AdapterType);
            setMode('model');
          }}
        />
      </Box>
    );
  }

  // mode === 'model'
  return (
    <Box flexDirection="column">
      <Text bold>2/3 · Novo agente</Text>
      <TextPrompt
        key="agent-model"
        label="Model (Enter pra usar o default do adapter):"
        placeholder="ex.: opus / sonnet"
        onSubmit={(m) => finishCreate(m)}
      />
    </Box>
  );
}

/**
 * Passo de canal (3/3): usa o agente ESCOLHIDO no passo 2 (`pickedAgentId`);
 * só re-resolve (orquestrador, ou o primeiro do workspace) se ele vier ausente.
 * Delega o connect/list pro componente reutilizável `ChannelConnect` — MESMA
 * implementação do comando `/channels` do REPL.
 */
function ChannelStep({
  workspaceId,
  pickedAgentId,
  onDone,
}: {
  workspaceId: string;
  pickedAgentId: string | null;
  onDone: () => void;
}): React.ReactElement {
  const [agentId] = useState<string | null>(() => {
    if (pickedAgentId) return pickedAgentId;
    const agentRepo = new AgentRepository();
    const orchestrator = agentRepo.getOrchestrator(workspaceId);
    if (orchestrator) return orchestrator.id;
    return agentRepo.listByWorkspace(workspaceId)[0]?.id ?? null;
  });
  const [connecting, setConnecting] = useState(false);

  if (!agentId) {
    return (
      <Box flexDirection="column">
        <Text bold>3/3 · Canal</Text>
        <Text color="red">Nenhum agente no workspace — crie um agente antes.</Text>
      </Box>
    );
  }

  // Canal é opcional no setup — deixa pular e conectar depois pelo `/channels`.
  if (!connecting) {
    return (
      <Box flexDirection="column">
        <Text bold>3/3 · Canal</Text>
        <Text dimColor>Conectar um canal agora? (↑↓ + Enter):</Text>
        <SelectList
          options={[
            { label: 'Conectar um canal', value: 'connect' },
            { label: 'Pular por agora (conecto depois em /channels)', value: 'skip' },
          ]}
          onSelect={(v) => (v === 'skip' ? onDone() : setConnecting(true))}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>3/3 · Canal</Text>
      <ChannelConnect workspaceId={workspaceId} agentId={agentId} onDone={onDone} />
    </Box>
  );
}

export function InitWizard(): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('workspace');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);

  return (
    <Box flexDirection="column">
      <CompactTitle subtitle="init · setup do daemon" />
      {step === 'workspace' ? (
        <WorkspaceStep
          onDone={(id) => {
            setWorkspaceId(id);
            setStep('agent');
          }}
        />
      ) : null}
      {step === 'agent' && workspaceId ? (
        <AgentStep
          workspaceId={workspaceId}
          onDone={(id) => {
            setAgentId(id);
            setStep('channel');
          }}
        />
      ) : null}
      {step === 'channel' && workspaceId ? (
        <ChannelStep
          workspaceId={workspaceId}
          pickedAgentId={agentId}
          onDone={() => setStep('done')}
        />
      ) : null}
      {step === 'done' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">Setup concluído.</Text>
          <Text>
            Agora rode <Text bold>orkestral serve</Text> pra subir o daemon.
          </Text>
          <DoneExit onExit={exit} />
        </Box>
      ) : null}
    </Box>
  );
}

/** Sai do Ink logo após o resumo (deixa o terminal livre). */
function DoneExit({ onExit }: { onExit: () => void }): React.ReactElement | null {
  useEffect(() => {
    const t = setTimeout(onExit, 200);
    return () => clearTimeout(t);
  }, [onExit]);
  return null;
}
