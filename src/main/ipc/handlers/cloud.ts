import { registerHandler } from '../register';
import { CloudAccountRepository } from '../../db/repositories/cloud-account.repo';
import { openCloudLogin, logoutCloud } from '../../services/cloud-auth';

/** Conta do Orkestral Cloud (login via web). Tokens ficam só no main. */
export function registerCloudHandlers(): void {
  registerHandler('cloud:get-account', async () => {
    const record = new CloudAccountRepository().get();
    if (!record) return null;
    return { email: record.email, name: record.name };
  });

  registerHandler('cloud:login-start', async () => {
    // null quando o Cloud não está configurado neste build (sem Supabase URL):
    // o renderer mostra "login indisponível" em vez de abrir um fluxo que sempre
    // seria recusado na verificação do token.
    return { url: openCloudLogin() };
  });

  registerHandler('cloud:logout', async () => {
    logoutCloud();
    return { ok: true as const };
  });
}
