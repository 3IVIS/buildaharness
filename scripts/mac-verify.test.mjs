import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
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

  describe('bundle mode', () => {
    let repo, sha
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
    // The fake ssh saves whatever is piped to the bundle upload and answers the poll with PASS.
    const bundleSsh = () => fakeSsh(`case "$*" in *repo.bundle*) cat > "${dir}/uploaded.bundle";; *"tail -n"*) echo "@@STATUS:0";; *) cat > /dev/null;; esac; exit 0`)
    const runIn = (args, ssh) => spawnSync('bash', [SCRIPT, ...args], {
      cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, MAC_VERIFY_SSH: ssh },
    })

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'macv-repo-'))
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
      writeFileSync(join(repo, 'a'), '1'); git('add', 'a'); git('commit', '-qm', 'one')
      writeFileSync(join(repo, 'a'), '2'); git('commit', '-qam', 'two')
      sha = git('rev-parse', 'HEAD')
    })

    it('sends an unpushed commit as a bundle and leaves no temp ref behind', () => {
      const r = runIn(['--commit', sha, '--poll', '0'], bundleSsh())
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('git bundle')
      expect(execFileSync('git', ['bundle', 'verify', join(dir, 'uploaded.bundle')], { cwd: repo, encoding: 'utf8' })).toBeDefined()
      expect(git('for-each-ref', 'refs/bah-verify')).toBe('')
    })

    it('does not bundle with --no-bundle', () => {
      const r = runIn(['--commit', sha, '--no-bundle', '--poll', '0'], bundleSsh())
      expect(r.stdout).not.toContain('git bundle')
    })

    it('does not bundle a commit a remote branch already contains', () => {
      git('update-ref', 'refs/remotes/origin/main', sha)
      const r = runIn(['--commit', sha, '--poll', '0'], bundleSsh())
      expect(r.stdout).not.toContain('git bundle')
      git('update-ref', '-d', 'refs/remotes/origin/main')
    })

    it('--bundle with a commit missing locally exits 2', () => {
      expect(runIn(['--commit', 'b'.repeat(40), '--bundle', '--poll', '0'], bundleSsh()).status).toBe(2)
    })
  })
})
