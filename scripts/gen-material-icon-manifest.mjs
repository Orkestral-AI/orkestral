// Gera o subset do manifest do material-icon-theme que o resolver de ícones do
// code-ide usa (só os mapas de nome->ícone). Rode após atualizar o pacote:
//   node scripts/gen-material-icon-manifest.mjs
// Saída: src/renderer/src/lib/materialIconManifest.json
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateManifest } from 'material-icon-theme';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'renderer', 'src', 'lib', 'materialIconManifest.json');

const m = generateManifest();
const subset = {
  file: m.file,
  folder: m.folder,
  folderExpanded: m.folderExpanded,
  fileNames: m.fileNames,
  fileExtensions: m.fileExtensions,
  folderNames: m.folderNames,
  folderNamesExpanded: m.folderNamesExpanded,
};
writeFileSync(out, JSON.stringify(subset) + '\n');
console.log(
  'wrote',
  out,
  '— fileNames:',
  Object.keys(subset.fileNames).length,
  'folderNames:',
  Object.keys(subset.folderNames).length,
);
