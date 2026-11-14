import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(__dirname, 'mac-verify.sh')
const SHA = 'a'.repeat(40)
let dir

// A fake ssh: prints stderr/exit per FAKE_MODE and records its arguments and stdin.
function fakeSsh(body) {
  const p = join(dir, 'ssh')
  writeFileSync(p, `#!/usr/bin/env bash\necho "$@" >> "${dir}/calls"\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

function run(args, ssh) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, MAC_VERIFY_SSH: ssh },
  })
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'macv-')) })

describe('mac-verify.sh', () => {
  it('rejects unknown arguments and bad values with exit 2', () => {
    const ssh = fakeSsh('exit 0')
    expect(run(['--bogus'], ssh).status).toBe(2)
    expect(run(['--commit', 'xyz;rm'], ssh).status).toBe(2)
    expect(run(['--commit', SHA, '--poll', 'x'], ssh).status).toBe(2)
    expect(run(['--commit', SHA, '--steps', 'a b'], ssh).status).toBe(2)
  })

  it('prints help with exit 0', () => {
    expect(run(['--help'], fakeSsh('exit 0')).status).toBe(0)
  })

  it('defers (76) when the Mac is unreachable', () => {
    const ssh = fakeSsh('echo "ssh: connect to host mac port 22: No route to host" >&2; exit 255')
    const r = run(['--commit', SHA, '--poll', '0'], ssh)
    expect(r.status).toBe(76)
    expect(r.stderr).toContain('deferring')
  })

  it('fails (1) on a non-network ssh error', () => {
    const ssh = fakeSsh('echo "Permission denied (publickey)." >&2; exit 255')
    expect(run(['--commit', SHA, '--poll', '0'], ssh).status).toBe(1)
  })

  it('passes on status 0, fails on non-zero status, using the safe ssh options', () => {
    const mk = (st) => fakeSsh(`case "$*" in *"tail -n"*) echo "== step install"; echo "@@STATUS:${st}";; esac; exit 0`)
    const ok = run(['--commit', SHA, '--poll', '0'], mk(0))
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('PASS')
    expect(run(['--commit', SHA, '--poll', '0'], mk(1)).status).toBe(1)
    const calls = readFileSync(join(dir, 'calls'), 'utf8')
    expect(calls).toContain('IdentitiesOnly=yes')
    expect(calls).toContain('BatchMode=yes')
    expect(calls).toContain('ConnectTimeout=10')
    expect(calls).toContain('bah-verify/run-aaaaaaaaaaaa')
  })
})
