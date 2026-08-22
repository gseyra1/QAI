/**
 * Surface publique du paquet.
 *
 * Deux usages, tenus par le même fichier : typer ce qu'on doit implémenter
 * (fournisseur de modèle, fournisseur d'état) et **embarquer le moteur** dans
 * un harnais existant — vitest, jest, un script maison. Sans ce second volet,
 * QAI ne serait utilisable que par sa ligne de commande, ce qui exclut toute
 * base de code qui a déjà son lanceur de tests.
 *
 * `PlaywrightWebDriver` est exporté d'ici : `playwright` reste externe au
 * paquet construit, l'import n'est donc pas payé par qui ne l'utilise pas.
 */
export type {
  Action,
  Capabilities,
  Cookie,
  Driver,
  Locator,
  PlatformFallback,
  PreparedState,
  ResolvedTarget,
  ResolveOutcome,
  Role,
  UINode,
  UISnapshot,
} from './driver/types.ts';

export type {
  ModelContent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  Pricing,
} from './model/types.ts';
export { costOf } from './model/types.ts';
export type { Budget, Spend } from './model/budget.ts';
export { BudgetedProvider, BudgetExceededError } from './model/budget.ts';

export type { StateProvider, StateRequest } from './state/types.ts';

export type { Given, Scenario, Step, TargetPlatform } from './scenario/types.ts';
export type { Check, CaptureSpec, Resolution, StepResolution } from './resolution/types.ts';

export type {
  AppliedHeal,
  AssertionFailure,
  Healer,
  HealRequest,
  HealResult,
  ScenarioReport,
  ScenarioStatus,
  StepReport,
  StepStatus,
} from './engine/run.ts';
export type { SuiteEntry, SuiteInput, SuiteItem, SuiteReport } from './engine/suite.ts';
export type { QaiConfig } from './config.ts';

// Le moteur, pour un harnais maison. `runScenario` prend un driver déjà lancé,
// `runSuite` s'occupe du cycle de vie et du parallélisme.
export type { RunInput } from './engine/run.ts';
export { runScenario } from './engine/run.ts';
export { runSuite } from './engine/suite.ts';

// Chargement : un scénario et sa résolution se lisent aussi hors du CLI.
export { loadScenario, parseScenario, ScenarioError } from './scenario/load.ts';
export { loadResolution, parseResolution, ResolutionError } from './resolution/load.ts';
export { saveResolution, serializeResolution } from './resolution/save.ts';
export { applyHeals } from './resolution/apply.ts';
export { RESOLUTION_VERSION } from './resolution/types.ts';

// Cohérence scénario/résolution : le contrôle qui attrape les faux verts.
export type { ConsistencyIssue, IssueKind } from './engine/consistency.ts';
export { checkConsistency, formatIssue } from './engine/consistency.ts';

// Génération et réparation : les deux étages qui appellent le modèle.
export type { GenerateInput, GenerateResult, GenerateStepReport } from './generate/generate.ts';
export { generateResolution } from './generate/generate.ts';
export type { ModelHealerOptions } from './heal/ModelHealer.ts';
export { ModelHealer } from './heal/ModelHealer.ts';

// Rendu des rapports, pour brancher QAI sur un reporter existant.
export type { JUnitOptions } from './report/junit.ts';
export { formatJUnit } from './report/junit.ts';
export type { MarkdownOptions } from './report/markdown.ts';
export { COMMENT_MARKER, formatMarkdown } from './report/markdown.ts';
export { formatIssues, formatReport, formatSuite } from './report/text.ts';
export { artifactWriter } from './report/artifacts.ts';

// Driver web et configuration.
export { PlaywrightWebDriver } from './driver/web/PlaywrightWebDriver.ts';
export { loadConfig } from './config.ts';
