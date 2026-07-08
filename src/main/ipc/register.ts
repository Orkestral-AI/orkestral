import { ipcMain } from '../platform/electron';
import type { IpcChannel, IpcHandler } from '../../shared/ipc-contract';

/**
 * Forma armazenada no registry: função com request contravariante (`never`),
 * pra aceitar qualquer `IpcHandler<C>` do contrato sem apagar a tipagem com any.
 */
type StoredHandler = (request: never) => unknown;

const handlers = new Map<IpcChannel, StoredHandler>();

/** Invoca um handler registrado com o wrapper de erro padrão: loga o erro
 *  completo no main e re-lança só a mensagem (serializável pro renderer/gateway). */
async function invokeHandler(channel: IpcChannel, request: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`IPC channel desconhecido: ${channel}`);
  }
  try {
    return await handler(request as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ipc] ${channel} falhou:`, error);
    throw new Error(message);
  }
}

/**
 * Registra um handler tipado para um canal IPC.
 * Garante:
 *  - assinatura compatível com o contrato compartilhado;
 *  - erro claro se o mesmo canal for registrado duas vezes;
 *  - serialização do erro: handlers podem lançar Error e o renderer recebe a mensagem.
 *
 * O registro vive num Map próprio, não só no ipcMain: em Node puro (CLI
 * standalone) não existe ipcMain, e o gateway HTTP despacha os MESMOS handlers
 * via `dispatchIpc`. Sob Electron, o canal também é exposto no ipcMain — o
 * caminho do renderer fica intacto.
 */
export function registerHandler<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void {
  if (handlers.has(channel)) {
    throw new Error(`IPC channel já registrado: ${channel}`);
  }
  handlers.set(channel, handler);

  ipcMain?.handle(channel, (_event, request) => invokeHandler(channel, request));
}

/**
 * Despacho direto (sem ipcMain) — usado pelo gateway HTTP/WS do CLI standalone
 * pra invocar os mesmos handlers do renderer, com o mesmo tratamento de erro.
 * Canal não registrado é erro claro (vira a resposta de erro do gateway).
 */
export function dispatchIpc(channel: string, request: unknown): Promise<unknown> {
  return invokeHandler(channel as IpcChannel, request);
}

/** Canais atualmente registrados — pro gateway montar rotas/validar e pra debug. */
export function listRegisteredChannels(): string[] {
  return [...handlers.keys()];
}
