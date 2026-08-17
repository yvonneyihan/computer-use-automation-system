# Design write-up

## 1. Architecture

One TypeScript/Node process, not services — nothing here needs independent scaling yet.
Two CLI entry points (`discover`, `replay`) assemble the same modules differently:

```
Surface (src/surface)        <-  the only thing that touches Playwright
  |                              observe() / perform() / extract() / resolveLocator()
  v
Agent loop (src/agent)  <---- discovery only: Claude tool-use, observe/decide/act
  |
  v
Artifact (src/artifact)      <-  Zod schema, recorder (trace -> artifact), JSON store
  |
  v
Replay engine (src/replay)   <-  production path: no LLM, fixed steps, result contract
```

`Safety` and `Observability` are cross-cutting: every action passes through
`AllowlistPolicy.evaluate()` before touching `Surface`, and both discovery and replay
write through the same `RunLogger`, so their evidence looks and reads identically.

**`Surface` is the key seam.** Both the agent loop and replay engine depend only on
`src/surface/surface.ts`, never Playwright directly. `observe()` returns an
accessibility-tree snapshot, not raw HTML; `perform()`/`extract()` take a ranked
`ElementLocator`, not a selector string. A legacy-web or desktop surface implements the
same four methods and nothing above this line changes (§3.7). Trade-off: `Surface` can
only express what the accessibility tree exposes — a truly inaccessible surface (e.g.
canvas-rendered) would need a screenshot+coordinate fallback I didn't build (§7).

**Perception, not coordinates.** The agent sees an accessibility snapshot + screenshot,
and acts through semantic locators (role/name, testId, text) — never pixel coordinates.
Coordinates are simpler but don't survive into a *replayable* artifact — they're tied to
one viewport/resolution and carry no reviewable meaning. Since the system exists to
"record once, replay as a stable capability," coordinate-clicking would undermine its
own purpose.

## 2. Artifact schema

`src/artifact/schema.ts` (Zod, `schemaVersion: "1.0"`), shaped around three questions a
reviewer and a calling agent both need answered: *what does this do, what does it need,
what does it return* — plus enough to make replay deterministic and diagnosable.

- **`inputSchema`/`outputSchema`** — typed, described params and outputs. `sensitive:
  true` drives redaction (§6); the recorder never writes a sensitive literal into
  `valueTemplate`, only `{{paramName}}`.
- **`steps`** — ordered actions with a ranked `ElementLocator` (§3) and a `description` —
  locator-robustness reasoning lives per-step, not just in prose.
- **`successCheckpoint`** — a machine-verifiable assertion (URL/element), not a step
  count. The agent proposes it when calling `finish()`; the recorder falls back to a
  URL-match if the proposal doesn't parse.
- **`outcomeChecks`** — the schema's central design choice. Declaring known business
  outcomes *inside the artifact* (not hardcoded in the replay engine) lets a reviewer see
  exactly which runtime conditions are legitimate vs. what's a hard failure.
- **`recoverySpec`** — cross-cutting interstitials (e.g. a cookie banner), checked once
  before every step rather than repeated per step.
- **`status: "draft"|"approved"`** — present, not enforced yet (§7); the gating seam
  exists even though nothing reads it.

Real example: `artifacts/add_item_to_cart_checkout.json`.

## 3. Determinism & error handling

Replay (`src/replay/engine.ts`) never calls an LLM. Determinism comes from a fixed step
sequence, `{{paramName}}` interpolation as the only per-run variable, and explicit
checkpoints instead of "click and hope."

**Locator resolution** tries tiers in order — `role+accessibleName → data-testid →
visible text → css` — stopping at the first that resolves, with a bounded wait per tier.
This keeps a capability working against markup without stable identifiers, the norm in
legacy UIs. Concretely: saucedemo.com uses `data-test`, not Playwright's default
`data-testid` — exactly the inconsistency this tiering exists for. `target.testIdAttribute`
records which convention an artifact was recorded with, so replay configures the same one
rather than guessing.

**The result contract** (`src/replay/result.ts`) has three branches, checked at every
step and the final checkpoint:

1. Action/checkpoint succeeds → `success`, with outputs.
2. Otherwise, does an `outcomeChecks` entry match? → `business_outcome` — e.g. a blank
   checkout field is asserted via `elementText` on the real `data-test="error"` banner.
   Checked before anything is called a failure, whether an action threw or a checkpoint
   silently didn't hold.
3. Otherwise → `failure`, with step index, expected vs. observed, and a message — plus
   automatic escalation (§5) instead of dying silently.

Every branch writes a screenshot + aria-snapshot before returning, so a failure is
debuggable without re-running it.

## 4. Heterogeneity & multi-tenant

*Design only, per §3.7.*

**Surface abstraction.** A legacy web surface still implements `Surface` over
Playwright — old server-rendered markup still has an accessibility tree, so resolution
just degrades toward the `text`/`css` tiers. A desktop surface implements the same four
methods over an OS accessibility API (macOS/Windows), which exposes the same role+name
concept the `role` tier already assumes — `ElementLocator` doesn't change, only what
resolves it. Nothing in `agent/`, `artifact/`, or `replay/` names Playwright, which is
what makes this a real seam.

**Multi-tenant reuse.** Split `target` into a tenant-agnostic `capabilityTemplate`
(steps, locators, input/output contract) and a `tenantBinding` (`baseUrl`, a
`locatorOverrides` map for tenants whose branding/config genuinely diverged). Same
capability reused across every tenant on that vendor app; an override, not a
re-recording, handles real divergence. `testIdAttribute` on `target` today is a small
instance of exactly this pattern.

**Drift detection.** Track `lastVerifiedAt` and a rolling success/failure count per
`(capability, tenant)`, populated by ordinary replay outcomes — no synthetic monitoring
needed. One tenant failing while others succeed signals that tenant drifted; everyone
failing signals the capability itself needs review. Canonicalizing concrete values into
patterns (`/item/12345 → /item/:id`) is the natural next step, not implemented (§7).

## 5. Escalation & handoff

**Detecting stuck.** Four triggers, in both flows: the agent explicitly calls `escalate`
(instructed on repeated failure, unexpected dialogs, or anything irreversible-looking);
max-steps/timeout in discovery; an unmatched `outcomeChecks` failure in replay (by
definition unanticipated); any action the allowlist classifies risky (§6).

**Control transfer.** The browser runs non-headless — a real, visible,
already-authenticated window for the whole run, so escalation pauses the live session
rather than opening a new one. `EscalationController.escalate()` writes
`intervention.json` (goal, step, reason) and blocks, polling for `resume.signal`. The
`operator` CLI reads the context, tells the human the window is open, and on `enter`
writes the resolved `intervention.json` plus the resume signal. The blocked process
re-observes the page; discovery feeds the human's summary back to Claude and continues,
replay reports the failure with the notes attached (doesn't auto-resume — §7).
`controller: "agent"|"human"` is the single source of truth for who's driving.

**Mocked vs. real.** The operator "console" is a terminal, not a co-browsing UI — the
explicitly-allowed mock. Real: the same Playwright page stays alive and untouched, a
human can click in it directly, and the file-based resume signal is a genuine
cross-process handoff — run end-to-end (`/evidence`).

## 6. Safety

**Allowlist** (`config/allowlist.json`) is checked before every action in both flows, not
just at start: domain scope, permitted action types, risky-action matchers. A confused
agent can't go off-domain or take a disallowed action type mid-run.

**Risky actions are blocked, not confirmed.** saucedemo's "Finish" button (the actual
order-submission step) is matched and blocked outright, in both flows. I chose
block-over-confirm because there's no standing human approver to confirm against; a real
deployment would route the block through escalation instead (§5's mechanism already
exists, just not wired to this) — I chose the more conservative default. The discovery
goal itself stops at the review screen, matching the assignment's own example.

**Redaction.** Two layers: field-name matching (`password|secret|token|...`) and
content-pattern matching (SSN, card-like digit runs, email), recursive over anything
logged. Field-name matching alone misses the agent loop's generic `text` field, so
`agent/loop.ts` separately checks the tool call's own `sensitive` flag before logging. A
sensitive field's literal value never reaches the artifact either — only `{{paramName}}`.
Screenshots mask `input[type="password"]`.

**Limits.** Risky-action matchers are hand-authored per app; nothing infers
"irreversible" structurally. Redaction is pattern-based defense in depth, not a guarantee
against every secret shape — this was validated during a real run: the redaction filter
false-positived twice (a `pin` substring match, a timestamp mistaken for a card number)
before both were caught and fixed.

## 7. Cuts

- **Operator console** — a CLI, not co-browsing. Explicitly allowed to mock; the handoff
  mechanism underneath is real.
- **Legacy-web and desktop surfaces** — designed (§4), not built, as instructed.
- **Screenshot+coordinate perception** — not built; would matter for a genuinely
  non-accessible surface (e.g. canvas UI), not the environment described in the brief.
- **Confidence scoring / approval gating** — `status` field exists, nothing reads it yet.
  Next: gate unattended (headless, no-escalation) replay on `approved`.
- **Stretch goals** (multi-run stability, LLM-assisted replay recovery, cross-tenant
  canonicalization) — skipped for full depth on the required core, per the brief's own
  preference.
- **Auto-resume after replay handoff** — reports the failure with notes rather than
  continuing. Next: re-verify the checkpoint post-resume and continue if it holds.