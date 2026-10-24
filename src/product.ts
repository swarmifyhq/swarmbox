// What a product gives Swarmbox: how to start a world of it, who is in that world, how each of them signs
// in, and how to check the world afterwards. Everything else, the screens and what an agent sees on
// them, the runs, findings and reports, the control room, is Swarmbox's and the same for every product.
//
// A world is one running copy of the product with its own data: started for a run, thrown away after it
// (or kept, if the product supports that). A tenant is one of the product's customers in that world, a
// company or a workspace, served on its own host: `<tenant>.<baseDomain>`, which resolves only inside the
// browsers Swarmbox launches. A product with no tenants has one.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from '@playwright/test';
import type { CheckResult, Settled } from './checks.ts';
import type { Harness } from './harness.ts';
import type { Hooks } from './hooks.ts';
import type { guard } from './mcp/server.ts';
import type { Provenance } from './provenance.ts';

/** Someone who can use a world: an employee, a member, an admin. Products may carry more. */
export interface Persona {
  /** Stable within a world; screen_open takes it. A feed row's principal is matched against it. */
  id: string;
  /** The tenant they belong to. */
  tenant: string;
  /** Who this is, for the control room, the report and the agent: "Jamie Lee (dispatcher)". */
  label: string;
  name: string;
  email: string;
  roles: string[];
  /** Where they are: "today" on their screen is decided in their browser, in this zone. */
  timeZone: string;
}

/** What a world is asked to be. */
export interface WorldSpec {
  /** Empty: the product's default (one tenant, or a kept world's own). */
  tenants: string[];
  /** Load the product's demo data. */
  seed: boolean;
  /** Keep this world's data under this name, across runs, if the product can. */
  keep?: string;
}

/** A cookie the browser starts with, for the tenant's own origin. */
export interface StartCookie {
  name: string;
  value: string;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** How one person's browser starts, signed in, in one app. */
export interface SignIn {
  cookies?: StartCookie[];
  /** Put in the tenant's localStorage before the app's scripts run (where absent). */
  localStorage?: Record<string, string>;
  /** A tablet's or phone's screen rather than a desktop's: touch on. */
  viewport?: { width: number; height: number };
  /** Where the app starts when the agent names no path. */
  path?: string;
  /** After the first load, before the screen is handed out: past a PIN screen, a welcome tour. */
  ready?(page: Page): Promise<void>;
}

/** One running world, as the product started it. */
export interface ProductWorld {
  /** Tenant hosts are `<tenant>.<baseDomain>`. */
  baseDomain: string;
  /** The port the product serves the tenants' hosts on. */
  port: number;
  tenants: string[];
  /** `http://<tenant>.<baseDomain>:<port>`. */
  origin(tenant: string): string;
  /** The product code it runs: a finding is only as good as the commit it names. */
  provenance: Provenance;
  /** The product's Swarmbox hooks, or null when it has none: then no feed, clock, inbox or fakes. */
  hooks: Hooks | null;
  /** Everyone who can sign in, in every tenant. */
  people(): Promise<Persona[]>;
  /** Sign a person in to one of the product's apps; app is undefined for its main one. */
  signIn(persona: Persona, app: string | undefined): Promise<SignIn>;
  /**
   * Which tenant a path on no particular host belongs to, when the path says (a customer link like
   * /p/<tenant>/…). Undefined: only a world with one tenant can take a bare path.
   */
  tenantOfPath?(path: string): string | undefined;
  /** Wait until the product's background work has caught up, per tenant. */
  settle(): Promise<Record<string, Settled>>;
  /** Run the product's invariant checks on the world as it is now (after settle). */
  check(): Promise<CheckResult[]>;
  /** Extra lines about the world for world_list: kept, migrations that failed. */
  notes?(): string[];
  stop(): Promise<void>;
}

/** Where a run's findings go besides its report: a tracker, an issue list. */
export interface FindingSink {
  /** Why nothing can be filed right now, or undefined when it can. */
  unavailable?: string;
  /** File one finding; returns its id there. */
  file(run: SinkRun, finding: SinkFinding): Promise<string>;
  /** Register a finished run. */
  register(run: SinkRun & { endedAt: string; failingChecks: number; reportPath: string }): Promise<void>;
}

export interface SinkRun {
  id: string;
  scenario: { id: string; title: string; try: string[]; expect: string[] };
  roles: string[];
  startedAt: string;
  provenance: string;
  commit: string;
  findings: number;
}

export interface SinkFinding {
  n: number;
  title: string;
  what: string;
  expected?: string;
  screenshot?: string;
}

/** A product, as Swarmbox drives it. */
export interface Product<W extends ProductWorld = ProductWorld> {
  /** Lowercase, for names and paths: "acme-crm". */
  name: string;
  /** As people write it, for the control room and reports: "Acme CRM". Default name. */
  title?: string;
  /** What the product calls a tenant, in what the agent reads: "company", "workspace". Default "tenant". */
  tenantNoun?: string;
  /** The first world's port; others take the next free one. 0: any free port, chosen by the product. */
  portBase: number;
  /** Where the scenarios are read and written. */
  scenarioDir: string;
  /** Where runs and the budget ledger are kept. */
  home: string;
  startWorld(spec: WorldSpec, port: number): Promise<W>;
  /**
   * The app a cast member opens when the scenario names none: a technician's tablet app. Undefined for
   * the product's main app.
   */
  appFor?(persona: Persona, world: W): Promise<string | undefined>;
  /** The apps screen_open offers, besides the main one. */
  apps?: string[];
  findings?: FindingSink;
  /** One line telling how to share a run's report, or nothing. */
  shareHint?(run: { dir: string; title: string }): string;
  /** The product's own tools, alongside Swarmbox's. */
  tools?(server: McpServer, ctx: ToolContext<W>): void;
  /** Stop anything the product keeps across worlds (a shared object store). */
  shutdown?(): Promise<void>;
}

/** What a product's own tools get to work with. */
export interface ToolContext<W extends ProductWorld> {
  harness: Harness<W>;
  /** Wrap a tool's body so a refusal reaches the agent as text, never a protocol error. */
  guard: typeof guard;
}
