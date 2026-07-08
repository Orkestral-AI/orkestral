import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { WorkspaceRepository } from '../../db/repositories/workspace.repo';
import { DirectoryPicker } from './DirectoryPicker';
import { TextPrompt } from './input/TextPrompt';

/**
 * Fluxo reutilizável de criação de workspace (nome → pasta → cria no repo).
 * Usado TANTO pelo `orkestral init` (passo 1/3, ramo "criar") QUANTO pelo
 * comando `/workspace` do REPL (entrada "+ criar novo workspace") — uma única
 * implementação, sem duplicar o nome/pasta em cada tela.
 *
 * `onCreated` recebe o id do workspace recém-criado; `onCancel` (Esc) volta.
 *
 * Cada passo monta um `<TextPrompt key={step} />` próprio: a `key` força o
 * remount entre 'name' e 'path', zerando o `value` interno do campo — senão o
 * React reaproveita o estado e a pasta nasce pré-preenchida com o nome digitado.
 */

export function WorkspaceCreate({
  onCreated,
  onCancel,
}: {
  onCreated: (workspaceId: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [step, setStep] = useState<'name' | 'path'>('name');
  const [name, setName] = useState('');

  if (step === 'name') {
    return (
      <Box flexDirection="column">
        <Text bold>Novo workspace</Text>
        <TextPrompt
          key="name"
          label="Nome do workspace:"
          placeholder="Meu projeto"
          onCancel={onCancel}
          onSubmit={(v) => {
            if (!v) return;
            setName(v);
            setStep('path');
          }}
        />
        <Text dimColor>Esc cancela</Text>
      </Box>
    );
  }

  // step === 'path' — navegador de pastas em vez de digitar o caminho inteiro.
  const create = (p?: string): void => {
    const created = new WorkspaceRepository().create({ name, path: p || undefined });
    onCreated(created.id);
  };

  return (
    <Box flexDirection="column">
      <Text bold>Novo workspace</Text>
      <Text dimColor>Pasta local do projeto — navegue e escolha:</Text>
      <DirectoryPicker
        key="path"
        initialPath={process.cwd()}
        onSelect={(p) => create(p)}
        onCancel={() => setStep('name')}
      />
    </Box>
  );
}
