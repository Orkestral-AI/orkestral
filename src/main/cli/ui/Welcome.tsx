import React from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { appInfo } from '../../platform/host';
import { BRANDING } from '../../../shared/branding';

/** Cores de marca do Orkestral (sem magenta). */
const ACCENT = '#a78bfa'; // roxo claro — títulos, prompt, topo do logo
const ACCENT_MID = '#8b5cf6'; // roxo médio — meio do logo
const ACCENT_DEEP = '#6d28d9'; // roxo profundo — base do logo

/**
 * Logo do Orkestral em ASCII: um anel/torus (donut com furo no meio) FACETADO —
 * half-blocks no contorno e sombreamento ▓/▒ nas quinas internas pra dar volume
 * (luz em cima, sombra embaixo). Cada linha tem sua própria cor pro degradê do
 * roxo (claro no topo → profundo embaixo), igual ao logo do produto.
 *
 *     ▄▄████▄▄
 *    ██▓▓  ▓▓██
 *    ██      ██
 *    ██▒▒  ▒▒██
 *     ▀▀████▀▀
 *
 * Primeira versão do facetado — o dono pode refinar. Os glifos podem renderizar
 * um pouco diferente dependendo da fonte do terminal.
 */
const LOGO_LINES: ReadonlyArray<{ text: string; color: string }> = [
  { text: '  ▄▄████▄▄', color: ACCENT }, // topo claro
  { text: ' ██▓▓  ▓▓██', color: ACCENT }, // faceta alta (luz)
  { text: ' ██      ██', color: ACCENT_MID }, // meio
  { text: ' ██▒▒  ▒▒██', color: ACCENT_DEEP }, // faceta baixa (sombra)
  { text: '  ▀▀████▀▀', color: ACCENT_DEEP }, // base profunda
];

/** Abaixo dessa largura, o welcome empilha logo e texto em vez de lado a lado. */
const NARROW_COLUMNS = 60;

function Logo(): React.ReactElement {
  return (
    <Box flexDirection="column" marginRight={2}>
      {LOGO_LINES.map((line, i) => (
        <Text key={i} color={line.color} bold>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Boas-vindas do REPL no estilo Claude Code: SEM box/borda. Ícone (anel do
 * Orkestral) à ESQUERDA e o texto empilhado à DIREITA — marca + versão,
 * saudação, modelo·agente e cwd. Embaixo, uma linha de dicas muted e, quando
 * há problemas de setup (canal desconectado, workspace sem pasta), uma linha
 * de avisos em amarelo dim. Em terminal estreito (< 60 colunas) as duas
 * colunas empilham (logo em cima, texto embaixo) pra nada quebrar no meio.
 *
 * Respeita NO_COLOR — só usa props de cor do Ink (sem ANSI cru); o Ink degrada
 * sozinho quando NO_COLOR está setado.
 */
export function Welcome({
  name,
  agentName,
  model,
  cwd,
  setupIssues = [],
}: {
  name?: string;
  agentName?: string;
  model?: string;
  cwd?: string;
  /** Avisos de setup calculados no boot do REPL (vazio = nenhuma linha extra). */
  setupIssues?: readonly string[];
}): React.ReactElement {
  const { columns } = useWindowSize();
  const narrow = columns < NARROW_COLUMNS;
  const greeting = name ? `Welcome back ${name}!` : 'Welcome!';
  const modelLine = [model, agentName].filter(Boolean).join(' · ');
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection={narrow ? 'column' : 'row'}>
        <Logo />
        <Box flexDirection="column" justifyContent="center" marginTop={narrow ? 1 : 0}>
          <Text>
            <Text bold color={ACCENT}>
              {BRANDING.appName}
            </Text>
            <Text dimColor> v{appInfo.version()}</Text>
          </Text>
          <Text bold>{greeting}</Text>
          {modelLine ? <Text dimColor>{modelLine}</Text> : null}
          {cwd ? <Text dimColor>{cwd}</Text> : null}
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>/help comandos · /channels canais · /config configs · /exit sair</Text>
        {setupIssues.length === 1 ? (
          <Text color="yellow" dimColor>
            1 aviso: {setupIssues[0]}
          </Text>
        ) : setupIssues.length > 1 ? (
          <>
            <Text color="yellow" dimColor>
              {setupIssues.length} avisos:
            </Text>
            {setupIssues.map((issue, i) => (
              <Text key={i} color="yellow" dimColor>
                {'  '}· {issue}
              </Text>
            ))}
          </>
        ) : null}
      </Box>
    </Box>
  );
}

/**
 * Título compacto (uma linha) pro InitWizard e telas de setup — não carrega o
 * welcome de duas colunas. Mostra a marca + versão + um subtítulo, na cor de
 * marca (sem magenta, sem box).
 */
export function CompactTitle({ subtitle }: { subtitle: string }): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text>
        <Text color={ACCENT} bold>
          {BRANDING.appName}
        </Text>
        <Text dimColor>
          {' '}
          v{appInfo.version()} · {subtitle}
        </Text>
      </Text>
    </Box>
  );
}
