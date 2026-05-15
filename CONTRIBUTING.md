# Contributing to Its Harness Flow Spec

## Start here

**Read the [RFC Discussion](#) first.** ← _replace with Discussion URL_

It explains every major design decision in the spec, what we're uncertain about, and what we're actively asking for input on. A lot of questions are already answered there; opening an issue to re-litigate a closed decision wastes everyone's time.

## What we need right now (Phase 0)

We're ~3 weeks from starting Phase 1 (canvas build + LangGraph adapter). After that, schema changes become breaking changes. **Now is the best time to push back on design decisions.**

The highest-value contributions at this stage:

- **Runtime feedback** — if you use LangGraph, CrewAI, Mastra, or MS Agent Framework seriously, tell us where the spec's model of your runtime is wrong or forced
- **Missing node types** — what pattern do you reach for in your flows that isn't representable in the 14 node types?
- **Python tool refs** — the `tool_ref` field is npm-only. This is wrong for the Python community. We need a solution.
- **In-flow eval** — we deferred an `eval` node. Tell us what you actually need.

## Issue labels

Use these prefixes in your issue title:

| Label | Use for |
|---|---|
| `[spec]` | Schema changes — new fields, changed types, new constraints |
| `[node-type]` | New node type proposals or changes to existing types |
| `[adapter]` | Questions or constraints specific to one runtime adapter |
| `[breaking]` | Anything that would invalidate currently valid flows |
| `[docs]` | README, CHANGELOG, or in-schema `describe()` improvements |
| `[flows]` | Changes to or additions of example flows |

## Making schema changes

The Zod schema (`spec/schema.ts`) is the canonical source of truth. The JSON Schema (`spec/schema.json`) is derived from it. **Never edit `schema.json` directly.**

Every schema PR must include:

1. **`spec/schema.ts`** — the change itself, with a `describe()` string explaining the field's semantics and adapter behaviour for each affected type
2. **`spec/schema.json`** — regenerate from the Zod schema (see below)
3. **`spec/CHANGELOG.md`** — one entry under the appropriate version
4. **At least one example flow** in `flows/` that demonstrates or validates the change

### Regenerating schema.json

```bash
cd spec
npx ts-node generate-schema.ts   # coming in Phase 1 — for now, open an issue and we'll regenerate
```

Until the generation script exists, include your `schema.ts` changes and we'll regenerate `schema.json` in review.

## Adding example flows

Example flows live in `flows/`. A valid example flow must:

- Pass validation against `spec/schema.json`
- Include `position` coordinates on all nodes (canvas rendering)
- Have a `description` field at the top level explaining what it demonstrates
- Exercise at least one node type or feature not already well-covered by the existing five flows
- Follow the naming convention: `NN-descriptive-name.json` (next available number)

## Code of conduct

Be direct. Disagree on specifics, not people. If a design decision was already made and documented, open a new issue with new evidence rather than re-litigating the original thread.
