/**
 * Motor v2 do Orkestral: o premium planeja e conduz, o Forge executa e prova.
 *
 * Mecanismo central (a "seta quebrada" do chatbot_v3, agora resolvida em codigo):
 *   gera -> valida import contra o real -> compila no overlay -> realimenta o erro -> verde.
 * O checkbox so fica verde com import valido + build verde. Verde = prova, nao afirmacao.
 *
 * Pecas:
 *   - import-validator: barra pacote/export inventado antes de tocar o disco.
 *   - compiler-check: typecheck do codigo proposto via overlay, sem escrever no disco.
 *   - execute-checkbox: o loop de um checkbox (ate verde ou escalar pro premium).
 *   - issue-runner: orquestra a checklist da issue, aplica, marca, contabiliza.
 *   - token-ledger: economia LIQUIDA honesta (premium gasto vs local), avisa prejuizo.
 *   - forge-adapter: liga o Forge local real (llamaChat) na interface GenerateFn.
 *
 * Ver docs/MOTOR-FATIAS-VERTICAIS.md.
 */
export {
  validateImports,
  clearImportValidatorCache,
  type ImportViolation,
  type ImportViolationKind,
  type ValidateImportsInput,
} from './import-validator';

export {
  typecheckProject,
  formatDiagnosticsForModel,
  type CompilerDiagnostic,
  type TypecheckInput,
  type TypecheckResult,
} from './compiler-check';

export {
  executeCheckbox,
  type Checkbox,
  type GenerateFn,
  type GenerateInput,
  type GenerateOutput,
  type ExecuteCheckboxResult,
  type ExecuteCheckboxInput,
  type CheckboxFailureStage,
} from './execute-checkbox';

export {
  runIssue,
  type Issue,
  type ConductFn,
  type ConductInput,
  type ConductOutput,
  type CheckpointSnapshot,
  type CheckboxRunResult,
  type RunIssueInput,
  type RunIssueResult,
} from './issue-runner';

export {
  emptyLedger,
  addPremium,
  addLocal,
  economyReport,
  economyLine,
  DEFAULT_PREMIUM_PRICING,
  type TokenLedger,
  type PremiumPricing,
  type EconomyReport,
} from './token-ledger';

export {
  createGenerate,
  buildGenerateUserPrompt,
  cleanModelOutput,
  estimateTokens,
  type GenerateAdapterDeps,
} from './generate-adapter';

export {
  planFromIntent,
  validatePlan,
  parsePlan,
  MAX_ISSUES,
  MAX_CHECKBOXES,
  type Plan,
  type PlannedIssue,
  type PlannedCheckbox,
  type PlanModelFn,
  type PlanResult,
} from './planner';

export {
  extractDesignContract,
  auditUiUsage,
  type DesignContract,
  type UiViolation,
} from './design-system';

export {
  planPreview,
  type PreviewPlan,
  type ProjectKind,
  type PreviewMode,
} from './preview-policy';

export {
  buildConductPrompt,
  createConduct,
  type PremiumChatFn,
  type PremiumChatOutput,
} from './conduct-adapter';

export {
  runPlan,
  type RunPlanInput,
  type RunPlanResult,
  type IssueRunSummary,
} from './plan-runner';

export {
  createEngineV2,
  createPlanModel,
  type EngineV2,
  type EngineV2Deps,
  type EngineV2RunInput,
} from './entry';

export {
  createAdapterPremiumChat,
  parsePremiumCompletion,
  isPremiumAdapter,
  FORGE_ADAPTER,
  type PremiumRunnerOptions,
} from './premium-runner';

export { runEngineV2InApp, type RunInAppInput } from './run-in-app';
export { validateForgeOutput, type ForgeGateVerdict } from './validate-output';
export { commitSlice, isGitRepo } from './slice-commit';
export { launchPreview, type PreviewHandle } from './preview-launcher';
export { gatherRepoContext, listProjectFiles } from './repo-context';
