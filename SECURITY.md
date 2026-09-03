# Security Policy

## Supported versions

Build A Harness is pre-1.0 and moves fast. Security fixes land on `main` and in
the next release of the affected `@buildaharness/*` package. Only the latest
released version of each package (and current `main`) is supported — there are no
backported patch branches yet.

| Package | Supported |
|---|---|
| `@buildaharness/*` — latest release + `main` | ✅ |
| Any earlier tagged version | ❌ (upgrade) |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub's ["Report a vulnerability"](https://github.com/3IVIS/buildaharness/security/advisories/new)
button (Security → Advisories on the repository). This opens a private advisory
only the maintainers can see.

If you cannot use GitHub advisories, open a regular issue that says only "security
report — please contact me" with no detail, and a maintainer will arrange a
private channel.

### What to expect

- **Acknowledgement:** within 5 business days.
- **Assessment + triage:** within 10 business days of acknowledgement, including a
  severity call and a rough fix timeline.
- **Disclosure:** coordinated. We aim to ship a fix and publish the advisory
  within 90 days of the report; we will credit you unless you ask us not to.

### Scope

In scope: the `@buildaharness/*` packages, the adapter API, the harness, and the
personal assistant. A finding is most useful when it defeats one of the trust
boundaries documented in [`docs/threat-model.md`](docs/threat-model.md) — for
example, secret exfiltration through an approved shell command, escaping the
file-tools workspace sandbox, or bypassing the fail-safe risk gate.

Out of scope: the explicitly accepted non-goals listed in the threat model (no OS
sandbox, plaintext secrets in `config.json`, prompt injection that only
influences the model's *text* without crossing a tool/effect boundary). Reporting
one of those as a vulnerability will get a pointer back to the threat model, not a
fix.
