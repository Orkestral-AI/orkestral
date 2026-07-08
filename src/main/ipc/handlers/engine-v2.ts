import { registerHandler } from '../register';
import { runEngineV2InApp } from '../../services/engine-v2/run-in-app';

/** Canal pra disparar uma fatia do motor v2 (premium planeja/conduz, Forge local executa). */
export function registerEngineV2Handlers(): void {
  registerHandler('engine-v2:run-slice', (req) =>
    runEngineV2InApp({
      workspaceId: req.workspaceId,
      intent: req.intent,
      projectRoot: req.projectRoot,
      port: req.port,
    }),
  );
}
