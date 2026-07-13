import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // Config de RUNTIME injetada no bundle do main em tempo de BUILD. Fonte (em
  // ordem de precedência): env do processo (CI/shell) > arquivo .env local
  // (gitignored). O SOURCE não carrega URL nenhuma (env-only, sem exposição no
  // open-source). Build sem as envs = strings vazias → defaults (Cloud off, HF).
  //   - local: crie um `.env` (veja .env.example) com ORKESTRAL_SUPABASE_URL etc.
  //   - oficial: o release.yml injeta via secret/env do CI.
  const env = { ...loadEnv(mode, process.cwd(), 'ORKESTRAL_'), ...process.env };
  const define = {
    'process.env.ORKESTRAL_SUPABASE_URL': JSON.stringify(env.ORKESTRAL_SUPABASE_URL ?? ''),
  };

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define,
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            cli: resolve('src/main/cli.ts'),
          },
        },
      },
      resolve: {
        alias: {
          '@main': resolve('src/main'),
          '@shared': resolve('src/shared'),
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/preload/index.ts'),
            webview: resolve(__dirname, 'src/preload/webview.ts'),
          },
          output: {
            entryFileNames: '[name].mjs',
          },
        },
      },
      resolve: {
        alias: {
          '@shared': resolve('src/shared'),
        },
      },
    },
    renderer: {
      root: resolve('src/renderer'),
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/renderer/index.html'),
            // Desktop pet — janela flutuante (docs/DESKTOP_PET.md).
            pet: resolve('src/renderer/pet.html'),
          },
          output: {
            // Forma FUNÇÃO (não array): casa por path em node_modules, então
            // nunca quebra se um pacote declarado não estiver instalado. Agrupa
            // os vendors pesados REAIS deste projeto em chunks próprios.
            manualChunks(id: string): string | undefined {
              if (!id.includes('node_modules')) return undefined;
              if (/node_modules\/@blocknote\//.test(id)) return 'editor';
              if (/node_modules\/framer-motion\//.test(id)) return 'motion';
              if (/node_modules\/@dicebear\//.test(id)) return 'avatars';
              if (/node_modules\/@xyflow\//.test(id)) return 'flow';
              if (/node_modules\/react-markdown\//.test(id)) return 'markdown';
              return undefined;
            },
          },
        },
      },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
        },
      },
      plugins: [react(), tailwindcss()],
    },
  };
});
