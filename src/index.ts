// Swarmbox: a sandbox where AI agents use your product the way people do, in real browsers against
// throwaway worlds, and see what a person sees and what the server did. A product plugs in with one object
// (Product, in product.ts); everything else here is the same for every product.

export type {
  FindingSink,
  Persona,
  Product,
  ProductWorld,
  SignIn,
  SinkFinding,
  SinkRun,
  StartCookie,
  ToolContext,
  WorldSpec,
} from './product.ts';
export { serve, DEFAULT_PORTS, type ServeOptions, type Served } from './serve.ts';
export {
  createHarness,
  feedLine,
  globMatches,
  HarnessError,
  linkPath,
  type Action,
  type Controller,
  type Harness,
  type HarnessOptions,
  type NetworkMode,
  type OpenScreenOptions,
  type ScreenEntry,
  type Signal,
  type WorldEntry,
} from './harness.ts';
export { serveMcp, buildServer, guard, type McpHttp } from './mcp/server.ts';
export { serveControlRoom, type ControlRoom } from './control-room/server.ts';
export {
  createRuns,
  type CastMember,
  type Finding,
  type RunRecord,
  type Runs,
  type Severity,
} from './runs/run.ts';
export { openBudget, budgetLimits, type Budget, type BudgetDay, type BudgetLimits } from './runs/budget.ts';
export { renderReport } from './runs/report.ts';
export { listScenarios, loadScenario, saveScenario, Scenario } from './scenarios/spec.ts';
export {
  failing,
  formatReport,
  type CheckResult,
  type Outcome,
  type Pending,
  type Settled,
  type Violation,
} from './checks.ts';
export {
  hooksFor,
  HooksMissing,
  HooksRefused,
  type ClockMove,
  type ClockState,
  type FakeRule,
  type FeedItem,
  type FeedPage,
  type Hooks,
} from './hooks.ts';
export { describeProvenance, provenance, type Provenance, type ProvenanceOptions } from './provenance.ts';
export {
  DEVICES,
  launchFleet,
  resolverRule,
  type Appearance,
  type Device,
  type Fleet,
  type Screen,
  type Who,
} from './fleet/browser.ts';
export {
  behindModal,
  changes,
  dialogsText,
  draw,
  glance,
  openDialogs,
  pickAmong,
  whyNotClicked,
  SIGNATURE,
  type Glance,
  type OpenDialog,
  type Stroke,
} from './fleet/sight.ts';
