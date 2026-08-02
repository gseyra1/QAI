/**
 * Surface publique du paquet.
 *
 * Tout ce qu'un utilisateur doit implémenter ou typer passe par ici : le
 * fournisseur de modèle, celui d'état, et les formes de scénario et de rapport.
 * Le reste — moteur, drivers — est interne et peut changer sans préavis.
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
export type { SuiteEntry, SuiteReport } from './engine/suite.ts';
export type { QaiConfig } from './config.ts';
