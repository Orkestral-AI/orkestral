import React from 'react';
import { Box, Text } from 'ink';
import { appInfo } from '../../platform/host';
import { BRANDING } from '../../../shared/branding';

/**
 * Banner de boas-vindas do CLI, num box arredondado com cor de marca (estilo
 * Claude Code): título colorido + versão, e — quando informados — o workspace
 * ativo, o cwd e uma linha de dicas. Respeita NO_COLOR (o Ink degrada sozinho;
 * sem ANSI cru aqui). `subtitle` segue como linha curta de contexto.
 */
export function Banner({
  subtitle,
  workspace,
  cwd,
  tips,
}: {
  subtitle: string;
  workspace?: string;
  cwd?: string;
  tips?: string;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="round"
      borderColor="#a78bfa"
      paddingX={1}
    >
      <Text>
        <Text color="#a78bfa" bold>
          ◆ {BRANDING.appName}
        </Text>
        <Text dimColor> v{appInfo.version()}</Text>
      </Text>
      <Text dimColor>{subtitle}</Text>
      {workspace ? (
        <Text>
          <Text dimColor>workspace </Text>
          <Text color="#a78bfa">{workspace}</Text>
        </Text>
      ) : null}
      {cwd ? (
        <Text>
          <Text dimColor>cwd </Text>
          <Text dimColor>{cwd}</Text>
        </Text>
      ) : null}
      {tips ? <Text dimColor>{tips}</Text> : null}
    </Box>
  );
}
