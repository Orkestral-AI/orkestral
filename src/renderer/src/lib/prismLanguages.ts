import { Prism } from 'prism-react-renderer';

/**
 * O bundle que vem dentro do prism-react-renderer só traz um subconjunto de
 * linguagens (js/ts/jsx/css/python/go/rust/...). Linguagens como PHP, Ruby,
 * Java, C#, SCSS, Bash, TOML e Dockerfile NÃO vêm e ficam sem cor no diff.
 *
 * Aqui expomos o Prism do renderer como global e carregamos as definições
 * extras do prismjs em cima dele. Ordem importa: `markup-templating` precisa
 * vir antes de `php`. Importar este módulo (uma vez, no entry) basta — os
 * arquivos do prismjs registram a linguagem por efeito colateral.
 */
(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;

// php depende de markup-templating
await import('prismjs/components/prism-markup-templating');
await import('prismjs/components/prism-php');

// demais linguagens que faltam no bundle padrão
await import('prismjs/components/prism-scss');
await import('prismjs/components/prism-ruby');
await import('prismjs/components/prism-java');
await import('prismjs/components/prism-csharp');
await import('prismjs/components/prism-toml');
await import('prismjs/components/prism-bash');
await import('prismjs/components/prism-docker');
