import { registerHandler } from '../register';
import {
  ping,
  listEngines,
  setEngine,
  listContainers,
  listImages,
  listVolumes,
  listNetworks,
  statsAll,
  containerAction,
  inspect,
  imageInspect,
  listFiles,
  startLogs,
  stopLogs,
  startStats,
  stopStats,
  startExec,
  execInput,
  execResize,
  execKill,
} from '../../services/docker-service';

export function registerDockerHandlers(): void {
  registerHandler('docker:ping', () => ping());
  registerHandler('docker:list-engines', () => listEngines());
  registerHandler('docker:set-engine', ({ socketPath }) => setEngine(socketPath));
  registerHandler('docker:list-containers', () => listContainers());
  registerHandler('docker:list-images', () => listImages());
  registerHandler('docker:image-inspect', ({ id }) => imageInspect(id));
  registerHandler('docker:list-volumes', () => listVolumes());
  registerHandler('docker:list-networks', () => listNetworks());
  registerHandler('docker:stats-all', () => statsAll());
  registerHandler('docker:container-action', ({ id, action }) => containerAction(id, action));
  registerHandler('docker:inspect', ({ id }) => inspect(id));
  registerHandler('docker:list-files', ({ id, path }) => listFiles(id, path));
  registerHandler('docker:logs-start', ({ id }) => startLogs(id));
  registerHandler('docker:logs-stop', ({ id }) => stopLogs(id));
  registerHandler('docker:stats-start', ({ id }) => startStats(id));
  registerHandler('docker:stats-stop', ({ id }) => stopStats(id));
  registerHandler('docker:exec-start', ({ id, cols, rows }) => startExec(id, cols, rows));
  registerHandler('docker:exec-input', ({ execId, data }) => execInput(execId, data));
  registerHandler('docker:exec-resize', ({ execId, cols, rows }) => execResize(execId, cols, rows));
  registerHandler('docker:exec-kill', ({ execId }) => execKill(execId));
}
