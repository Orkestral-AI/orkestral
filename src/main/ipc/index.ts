import { registerAppHandlers } from './handlers/app';
import { registerCloudHandlers } from './handlers/cloud';
import { registerWorkspaceHandlers } from './handlers/workspace';
import { registerSettingsHandlers } from './handlers/settings';
import { registerUserHandlers } from './handlers/user';
import { registerOnboardingHandlers } from './handlers/onboarding';
import { registerAdapterHandlers } from './handlers/adapters';
import { registerChatHandlers } from './handlers/chat';
import { registerProjectHandlers } from './handlers/projects';
import { registerDialogHandlers } from './handlers/dialog';
import { registerGithubHandlers } from './handlers/github';
import { registerAzureDevopsHandlers } from './handlers/azure-devops';
import { registerSentryHandlers } from './handlers/sentry';
import { registerObservabilityHandlers } from './handlers/observability';
import { registerSkillsIssuesHandlers } from './handlers/skills-issues';
import { registerSourcesHandlers } from './handlers/sources';
import { registerKbHandlers } from './handlers/kb';
import { registerGitHandlers } from './handlers/git';
import { registerAttachmentHandlers } from './handlers/attachments';
import { registerSmartExecHandlers } from './handlers/smart-exec';
import { registerLogsHandlers } from './handlers/logs';
import { registerSystemHandlers } from './handlers/system';
import { registerDataHandlers } from './handlers/data';
import { registerUpdateHandlers } from './handlers/updates';
import { registerVoiceHandlers } from './handlers/voice';
import { registerTerminalHandlers } from './handlers/terminal';
import { registerDockerHandlers } from './handlers/docker';
import { registerChannelHandlers } from './handlers/channels';
import { registerEngineV2Handlers } from './handlers/engine-v2';
import { registerPreviewHandlers } from './handlers/preview';

/**
 * Registra todos os handlers IPC. Chamado uma vez no boot do main,
 * após `initDatabase()`. Handlers que dependem do DB precisam vir
 * depois da inicialização do banco.
 */
export function registerAllIpcHandlers(): void {
  registerAppHandlers();
  registerCloudHandlers();
  registerWorkspaceHandlers();
  registerSettingsHandlers();
  registerUserHandlers();
  registerOnboardingHandlers();
  registerAdapterHandlers();
  registerChatHandlers();
  registerProjectHandlers();
  registerDialogHandlers();
  registerGithubHandlers();
  registerAzureDevopsHandlers();
  registerSentryHandlers();
  registerObservabilityHandlers();
  registerSkillsIssuesHandlers();
  registerSourcesHandlers();
  registerKbHandlers();
  registerGitHandlers();
  registerAttachmentHandlers();
  registerSmartExecHandlers();
  registerLogsHandlers();
  registerSystemHandlers();
  registerDataHandlers();
  registerUpdateHandlers();
  registerVoiceHandlers();
  registerTerminalHandlers();
  registerDockerHandlers();
  registerChannelHandlers();
  registerEngineV2Handlers();
  registerPreviewHandlers();
}
