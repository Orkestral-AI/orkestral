// afterSign hook do electron-builder: notariza o .app no macOS com o notarytool da
// Apple — mas SÓ quando as credenciais estão presentes (secrets do CI). Sem elas,
// pula em silêncio, então o build não-assinado (ad-hoc) continua funcionando igual.
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] sem credenciais Apple — pulando notarização (build ad-hoc).');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] notarizando ${appName}.app … (pode levar alguns minutos)`);
  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log('[notarize] notarização concluída.');
};
