import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { openExternalSafe } from './utils/safe-shell';

/**
 * Menu da aplicação com o nome "Orkestral" fixado em TODOS os rótulos.
 *
 * Por que isso existe: em `dev` o app roda no binário cru `Electron.app`, cujo
 * `CFBundleName` é "Electron" — então o menu PADRÃO do macOS mostra "Electron"
 * no negrito e em "Ocultar/Sair/Sobre Electron", mesmo com `app.setName`. Ao
 * definir um menu próprio com rótulos explícitos, forçamos "Orkestral" também
 * em dev. No app empacotado (.dmg) o nome já viria do productName, mas manter o
 * menu explícito garante consistência e os atalhos de Editar/Visualizar.
 */
export function buildApplicationMenu(): void {
  const appName = 'Orkestral';
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: `Sobre o ${appName}` },
        { type: 'separator' },
        { role: 'services', label: 'Serviços' },
        { type: 'separator' },
        { role: 'hide', label: `Ocultar ${appName}` },
        { role: 'hideOthers', label: 'Ocultar Outros' },
        { role: 'unhide', label: 'Mostrar Tudo' },
        { type: 'separator' },
        { role: 'quit', label: `Sair do ${appName}` },
      ],
    });
  }

  // Editar — essencial pra copiar/colar em campos de texto.
  template.push({
    label: 'Editar',
    submenu: [
      { role: 'undo', label: 'Desfazer' },
      { role: 'redo', label: 'Refazer' },
      { type: 'separator' },
      { role: 'cut', label: 'Recortar' },
      { role: 'copy', label: 'Copiar' },
      { role: 'paste', label: 'Colar' },
      { role: 'selectAll', label: 'Selecionar Tudo' },
    ],
  });

  // Visualizar — recarregar e devtools (úteis em dev e suporte).
  template.push({
    label: 'Visualizar',
    submenu: [
      { role: 'reload', label: 'Recarregar' },
      { role: 'forceReload', label: 'Forçar Recarregar' },
      { role: 'toggleDevTools', label: 'Ferramentas de Desenvolvedor' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Tamanho Real' },
      { role: 'zoomIn', label: 'Aumentar Zoom' },
      { role: 'zoomOut', label: 'Diminuir Zoom' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Tela Cheia' },
    ],
  });

  // Janela.
  template.push({
    label: 'Janela',
    submenu: [
      { role: 'minimize', label: 'Minimizar' },
      { role: 'zoom', label: 'Zoom' },
      ...(isMac
        ? ([
            { type: 'separator' },
            { role: 'front', label: 'Trazer Tudo para a Frente' },
          ] as MenuItemConstructorOptions[])
        : ([{ role: 'close', label: 'Fechar' }] as MenuItemConstructorOptions[])),
    ],
  });

  // Ajuda.
  template.push({
    role: 'help',
    label: 'Ajuda',
    submenu: [
      {
        label: `Sobre o ${appName}`,
        click: () => app.showAboutPanel(),
      },
      {
        label: 'Site do Orkestral',
        click: () => {
          void openExternalSafe('https://orkestral.ai');
        },
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
