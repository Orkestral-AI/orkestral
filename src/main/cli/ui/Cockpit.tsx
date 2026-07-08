import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Banner } from './Banner';
import { FeedBuffer } from '../feed-buffer';
import { feedTime, formatFeedEvent } from '../feed-format';
import { collectStatus, type DaemonStatus } from '../status';
import { chatStreamBus } from '../../services/chat-service';
import type { ChatStreamEvent } from '../../../shared/types';

const feed = new FeedBuffer(12);
/** Intervalo do refresh do status (canais conectando/caindo ao vivo). */
const STATUS_REFRESH_MS = 5000;

export function Cockpit({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
  const { exit } = useApp();
  const [, force] = useState(0);
  const [status, setStatus] = useState<DaemonStatus>(() => collectStatus(workspaceId));
  useInput((input) => {
    if (input === 'q') exit();
  });
  // Status AO VIVO: re-coleta a cada 5s (o de montagem ficava stale — canal que
  // conectava/caía depois do boot nunca aparecia).
  useEffect(() => {
    const timer = setInterval(() => setStatus(collectStatus(workspaceId)), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [workspaceId]);
  useEffect(() => {
    const onEvent = (e: ChatStreamEvent): void => {
      const text = formatFeedEvent(e);
      if (!text) return;
      feed.push({ ts: Date.now(), text });
      force((n) => n + 1);
    };
    chatStreamBus.on('event', onEvent);
    return () => {
      chatStreamBus.off('event', onEvent);
    };
  }, []);
  return (
    <Box flexDirection="column">
      <Banner subtitle={`serve · v${status.version} · headless`} />
      <Text>DB {status.dbPath}</Text>
      <Text>
        Workspace {status.workspace?.name ?? '—'} · Agente {status.agent?.name ?? '—'} ·{' '}
        {status.agent?.model ?? '—'}
      </Text>
      {status.channels.map((c) => (
        <Text key={c.type}>
          Canal {c.type} {c.status === 'connected' ? '● conectado' : `○ ${c.status}`}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Feed ao vivo (q sai)</Text>
        {feed.lines().map((l, i) => (
          <Text key={i}>
            <Text dimColor>{feedTime(l.ts)}</Text> {l.text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
