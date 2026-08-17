# Computer-Use Automation System

A small, real version of interface.ai's discovery → capability → replay pipeline: an LLM drives a live web app to accomplish a goal once, records what it did as a typed,
versioned "capability" artifact, and a separate deterministic engine replays that
artifact — with input params, extracted outputs, and structured error/outcome
handling — without the LLM in the loop.

See [`REPORT.md`](./REPORT.md) for the design write-up (architecture, artifact schema,
determinism/error handling, heterogeneity & multi-tenant story, escalation/handoff,
safety, and what was cut).

Target surface for this implementation: [saucedemo.com](https://www.saucedemo.com), a
public e-commerce demo site — chosen because it gives a genuine multi-step flow (login → inventory → cart → checkout form → checkout review) and has real, reproducible business outcomes to replay against (a required-field validation error), without needing a real bank system or fabricated failures.

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium   # one-time browser download
cp .env.example .env              # then add your ANTHROPIC_API_KEY
```

`.env`:

```
ANTHROPIC_API_KEY=sk-ant-...   # required for `discover`; never used by `replay`
ANTHROPIC_MODEL=claude-sonnet-5
HEADED=true                    # false runs the browser headless
```

### Running without live services

The unit test suite needs no API key and no network access (it uses a mock `Surface` and a real headless browser only against static, local HTML for the locator-resolution
tests):

```bash
npm test
```

`npm run replay` also needs no API key — replay never calls the LLM by design. It does
need network access to saucedemo.com and a local Chromium (installed above).

## Demo path

**1. Discovery** — a real LLM-driven run against the live site, produces a capability
artifact under `/artifacts` and evidence under `/evidence`:

```bash
npm run discover -- --goal "Add the Sauce Labs Backpack to the cart and reach the checkout overview page"
```

This logs in as the site's public demo user, adds the item, fills the checkout form, and stops at the review screen (it will not click "Finish" — see `config/allowlist.json` and REPORT.md § Safety for why). On success it prints the exact `replay` command to run next.

The agent chose to parameterize the login credentials too (not just the checkout form),
so the saved artifact's inputs are `username`, `secret_field_1` (password, marked
sensitive), `firstName`, `lastName`, `zipCode` — the exact set it printed after a
successful run. The item itself was recorded as a fixed step, not a parameter, since the agent only ever added the one item this run.

**2. Replay (success path)** — deterministic, no LLM:

```bash
npm run replay -- --artifact artifacts/add_item_to_cart_checkout.json \
  --params '{"username":"standard_user","secret_field_1":"secret_sauce","firstName":"Jane","lastName":"Doe","zipCode":"94107"}'
```

**3. Replay (business-outcome path)** — same artifact, an intentionally incomplete
input triggers the site's real required-field validation, which the artifact declares as a known business outcome rather than a crash:

```bash
npm run replay -- --artifact artifacts/add_item_to_cart_checkout.json \
  --params '{"username":"standard_user","secret_field_1":"secret_sauce","firstName":"","lastName":"Doe","zipCode":"94107"}'
```

Both replay runs print a structured `ReplayOutcome` (`success` / `business_outcome` /
`failure`) and leave a full evidence trail under `/evidence/<runId>/`.

**4. Replay (hard failure → human escalation), optional** — wrong credentials produce an
unrecognized failure (not the declared `validation_error` outcome), which escalates:

```bash
npm run replay -- --artifact artifacts/add_item_to_cart_checkout.json \
  --params '{"username":"wrong_user","secret_field_1":"wrong_password","firstName":"Jane","lastName":"Doe","zipCode":"94107"}'
```

This blocks — see the next section for how to resolve it. A full example run is already
saved under `/evidence/` if you'd rather just inspect one than trigger a fresh one.

### Human escalation / handoff

If discovery hits max steps/timeout, or explicitly calls its `escalate` tool, or replay
hits a hard failure not covered by the artifact's declared `outcomeChecks`, the run
writes `/evidence/<runId>/intervention.json`, prints the run id, and blocks — the live
browser window stays open exactly as it was. (A blocked risky/out-of-allowlist action is
handled differently: it's reported as an immediate failure rather than escalated — see
REPORT.md § Safety for why.) In another terminal:

```bash
npm run operator -- --run <runId>
```

This prints the intervention context, lets you interact with that same open browser
window directly, and on `enter` writes a resume signal that unblocks the paused run. For
discovery, the agent loop resumes and keeps working toward the goal from the current
state. For replay, the run does not continue the remaining steps — it reports a
structured failure with your notes attached, so you know what happened (see REPORT.md §
Cuts — auto-resuming replay after a handoff is a documented next step, not yet built).
See REPORT.md § Escalation & handoff for the full design and what's mocked (the operator
UI is a CLI, not a co-browsing console) vs. what's real (the pause/cede/resume mechanism
against the live session, which this ran genuinely against — see `/evidence/`).

## Project layout

```
src/
  surface/        Surface interface (the seam) + Playwright implementation
  agent/          LLM discovery loop: perceive -> Claude tool-call -> act
  artifact/       Zod schema for the capability artifact + JSON store + recorder
  replay/         Deterministic replay engine + result contract
  safety/         Allowlist enforcement + redaction
  escalation/      Stuck detection, intervention requests, pause/resume
  observability/  Structured JSONL logging + evidence capture
  cli/            discover / replay / operator entry points
artifacts/         Saved capability artifacts (JSON)
evidence/          Per-run logs, screenshots, results
config/            Allowlist / safety policy
```
