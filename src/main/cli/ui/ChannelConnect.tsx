import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { qrToString } from '../qr';
import { TextPrompt } from './input/TextPrompt';
import { ChannelRepository } from '../../db/repositories/channel.repo';
import { channelManager } from '../../services/channels/channel-manager';
import type { ChannelAccount, ChannelStatus, ChannelType } from '../../../shared/types';

/**
 * Componente reutilizável de conexão/listagem de canais. Usado tanto pelo
 * `orkestral init` (passo 3/3) quanto pelo comando `/channels` do REPL — ÚNICA
 * implementação compartilhada. Lista as contas existentes com status e deixa
 * conectar uma nova (WhatsApp via QR no terminal; Telegram/Discord via token).
 *
 * Toda a I/O roda contra os serviços reais (channelManager / ChannelRepository),
 * iguais aos que o InitWizard já usava: createAccount/setConfig/connect/
 * getRawQr/listSnapshots.
 */

const CHANNEL_OPTIONS: { value: ChannelType; label: string }[] = [
  { value: 'whatsapp', label: 'WhatsApp (QR)' },
  { value: 'telegram', label: 'Telegram (token do bot)' },
  { value: 'discord', label: 'Discord (token do bot)' },
];

const STATUS_COLOR: Record<ChannelStatus, string> = {
  connected: 'green',
  qr: 'yellow',
  connecting: 'yellow',
  disconnected: 'gray',
};

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

/** Linha de uma conta existente: tipo + status colorido + selfId quando houver. */
function AccountRow({ account }: { account: ChannelAccount }): React.ReactElement {
  return (
    <Text>
      <Text color="cyan">{account.channelType}</Text>
      <Text> · </Text>
      <Text color={STATUS_COLOR[account.status]}>{account.status}</Text>
      {account.selfId ? <Text dimColor> · {account.selfId}</Text> : null}
      {account.lastError ? <Text color="red"> · {account.lastError}</Text> : null}
    </Text>
  );
}

type View = 'list' | 'pick' | 'token' | 'connecting';

/** Contas do workspace ATUAL — a tela de canais nunca mistura workspaces. */
function listWorkspaceAccounts(workspaceId: string): ChannelAccount[] {
  return new ChannelRepository().listAccounts().filter((a) => a.workspaceId === workspaceId);
}

export function ChannelConnect({
  workspaceId,
  agentId,
  onDone,
}: {
  workspaceId: string;
  agentId: string;
  onDone: () => void;
}): React.ReactElement {
  const [accounts, setAccounts] = useState<ChannelAccount[]>(() =>
    listWorkspaceAccounts(workspaceId),
  );
  // Sem contas → já cai direto no fluxo de conexão (igual ao init); com contas,
  // mostra a lista primeiro com a opção de conectar uma nova.
  const [view, setView] = useState<View>(accounts.length > 0 ? 'list' : 'pick');
  const [channelType, setChannelType] = useState<ChannelType>('whatsapp');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [info, setInfo] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  // QR renderizado DENTRO da árvore do Ink (nunca console.log — o redraw do Ink
  // duplicaria/atropelaria o print). `lastRawQr` detecta a ROTAÇÃO do QR do
  // WhatsApp: quando o raw muda, re-renderiza o novo.
  const [qrText, setQrText] = useState<string | null>(null);
  const lastRawQr = useRef<string | null>(null);

  /** Cancela a tentativa em andamento (derruba a conexão pendente — sem conta
   *  "zumbi" em connecting) e volta pra lista de canais. */
  const cancelConnect = (): void => {
    if (accountId) {
      void channelManager.disconnect(accountId).catch(() => {
        /* best-effort — a conta fica marcada disconnected pelo próprio manager */
      });
    }
    lastRawQr.current = null;
    setQrText(null);
    setAccountId(null);
    setError(null);
    setInfo('');
    setAccounts(listWorkspaceAccounts(workspaceId));
    setView('list');
  };

  // Esc: durante o connect, CANCELA a tentativa (não fecha a tela); nas demais
  // views fecha a tela de canais (volta pro prompt no REPL, ou pula o passo no
  // init). As listas/inputs internos só tratam setas/Enter — sem conflito.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (view === 'connecting') cancelConnect();
    else onDone();
  });

  // Polling do snapshot da conta: desenha/atualiza o QR enquanto o status é 'qr'
  // e encerra quando vira 'connected'. Roda só durante 'connecting'.
  useEffect(() => {
    if (view !== 'connecting' || !accountId) return undefined;
    const timer = setInterval(() => {
      const snap = channelManager.listSnapshots(channelType).find((s) => s.id === accountId);
      if (!snap) return;
      if (snap.status === 'qr') {
        const raw = channelManager.getRawQr(accountId);
        if (raw && raw !== lastRawQr.current) {
          lastRawQr.current = raw;
          setQrText(qrToString(raw));
          setInfo('Escaneie o QR abaixo no WhatsApp (Aparelhos conectados).');
        }
      }
      if (snap.lastError) setError(snap.lastError);
      if (snap.status === 'connected') {
        clearInterval(timer);
        onDone();
      }
    }, 500);
    return () => clearInterval(timer);
  }, [view, accountId, channelType, onDone]);

  const startConnect = (type: ChannelType, token?: string): void => {
    if (!agentId) {
      setError('Nenhum agente no workspace — crie um agente antes.');
      return;
    }
    const account = channelManager.createAccount({ channelType: type, workspaceId, agentId });
    lastRawQr.current = null;
    setQrText(null);
    setError(null);
    setAccountId(account.id);
    if (token) channelManager.setConfig(account.id, { agentId, allowlist: [], token });
    setView('connecting');
    setInfo(type === 'whatsapp' ? 'Abrindo conexão… aguarde o QR.' : 'Conectando o bot…');
    void channelManager.connect(account.id).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  if (view === 'list') {
    const options: SelectOption[] = [{ label: '+ conectar novo canal', value: '__new__' }];
    return (
      <Box flexDirection="column">
        <Text bold>Canais</Text>
        {accounts.map((a) => (
          <AccountRow key={a.id} account={a} />
        ))}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Conectar um novo canal (↑↓ + Enter · Esc fecha):</Text>
          <SelectList options={options} onSelect={() => setView('pick')} />
        </Box>
      </Box>
    );
  }

  if (view === 'pick') {
    return (
      <Box flexDirection="column">
        <Text bold>Conectar canal</Text>
        <Text dimColor>Escolha o canal (↑↓ + Enter):</Text>
        <SelectList
          options={CHANNEL_OPTIONS.map((c) => ({ label: c.label, value: c.value }))}
          onSelect={(v) => {
            const type = v as ChannelType;
            setChannelType(type);
            if (type === 'whatsapp') startConnect(type);
            else setView('token');
          }}
        />
      </Box>
    );
  }

  if (view === 'token') {
    return (
      <Box flexDirection="column">
        <Text bold>Conectar canal</Text>
        <TextPrompt
          label={`Token do bot ${channelType === 'telegram' ? 'Telegram' : 'Discord'}:`}
          mask
          onSubmit={(token) => {
            if (!token) {
              setError('Token vazio.');
              return;
            }
            startConnect(channelType, token);
          }}
        />
        {error ? <Text color="red">{error}</Text> : null}
      </Box>
    );
  }

  // view === 'connecting'
  return (
    <Box flexDirection="column">
      <Text bold>Conectando · {channelType}</Text>
      {info ? <Text>{info}</Text> : null}
      {!qrText && channelType === 'whatsapp' ? <Text dimColor>Gerando QR…</Text> : null}
      {qrText ? <Text>{qrText}</Text> : null}
      <Text dimColor>
        {qrText ? 'QR atualiza sozinho · Esc cancela' : 'Aguardando conexão… (Esc cancela)'}
      </Text>
      {error ? <Text color="red">Erro: {error}</Text> : null}
    </Box>
  );
}
