import { describe, it, expect } from 'vitest';
import { detectDegenerateContent } from './degeneration';

describe('detectDegenerateContent', () => {
  it('pega o loop real: mesmo import repetido ~30x', () => {
    const bad =
      'import { Button } from "@/components/ui/button";\n' +
      Array.from(
        { length: 30 },
        () =>
          'import { useUploaderUrlState } from "@/features/ai-studio/agents/useUploaderUrlState";',
      ).join('\n') +
      '\nexport default function Page() { return null; }';
    expect(detectDegenerateContent(bad, 'page.tsx')).toMatch(/repetido/i);
  });

  it('pega linha substancial repetida em loop', () => {
    const bad =
      'function f() {\n' +
      Array.from({ length: 12 }, () => '  doTheExactSameThingOverAndOver(value, options);').join(
        '\n',
      ) +
      '\n}';
    expect(detectDegenerateContent(bad, 'x.ts')).toMatch(/repetida/i);
  });

  it('NÃO marca um componente React legítimo como degenerado', () => {
    const good = `import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Entrar</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail" />
        <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
        <Button className="w-full">Entrar</Button>
      </CardContent>
    </Card>
  );
}`;
    expect(detectDegenerateContent(good, 'login.tsx')).toBeNull();
  });

  it('ignora arquivos pequenos', () => {
    expect(detectDegenerateContent('export const x = 1;\nexport const y = 2;', 'a.ts')).toBeNull();
  });
});
