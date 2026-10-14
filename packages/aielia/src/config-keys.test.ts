import { describe, it, expect, vi, afterEach } from 'vitest'
import { CONFIG_KEYS } from './config.js'
import { ENV_KEYS, ENUM_CHOICES, envOverridesFrom, envVarFor, formatChoices, normalizeLlmBackend, parseShellNetworkAllowlist } from './config-keys.js'
import { parseConfigValue, ConfigValueParseError } from './cli-config.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const quiet = (): void => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
}

describe('ENV_KEYS table', () => {
  it('only names real config keys, once each, with unique variable names per surface', () => {
    const keys = ENV_KEYS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(CONFIG_KEYS as readonly string[]).toContain(key)
    for (const surface of ['cli', 'vite'] as const) {
      const names = ENV_KEYS.map((s) => s[surface]).filter(Boolean)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('build-time variables carry the VITE_ prefix, except the one desktop reads at runtime', () => {
    for (const spec of ENV_KEYS) {
      if (spec.vite && !spec.viteDisplayOnly) expect(spec.vite).toMatch(/^VITE_ASSISTANT_/)
    }
  })

  it('records which keys exist on one surface only', () => {
    const cliOnly = ENV_KEYS.filter((s) => s.cli && !s.vite).map((s) => s.key)
    const viteOnly = ENV_KEYS.filter((s) => !s.cli && s.vite).map((s) => s.key)
    expect(viteOnly).toEqual(['webBackend'])
    // Everything the apps cannot pin at build time today: secrets and CLI process settings, plus the limits U4b gave the apps without a build-time pin.
    expect(cliOnly).toEqual(expect.arrayContaining(['apiKey', 'braveApiKey', 'enableShell', 'enableEmail', 'tuiMode', 'updateCheck', 'sessionCostLimitUsd', 'sessionCallLimit', 'ambiguityGuardMode', 'activeProject']))
  })

  it('derives the per-surface name maps the settings views read', () => {
    expect(envVarFor('cli').proxyUrl).toBe('ASSISTANT_PROXY_URL')
    expect(envVarFor('vite').proxyUrl).toBe('VITE_ASSISTANT_PROXY_URL')
    expect(envVarFor('vite').llmBackend).toBe('ASSISTANT_LLM_BACKEND')
    expect(envVarFor('cli').webBackend).toBeUndefined()
  })
})

describe('the CLI and the Vite builder read shared keys the same way', () => {
  const shared = ENV_KEYS.filter((s) => s.cli && s.vite && !s.viteDisplayOnly)

  it('give the same value for the same raw input, and the same fallback for a bad one', () => {
    quiet()
    for (const spec of shared) {
      const cliName = spec.cli as string
      const viteName = spec.vite as string
      const choices = ENUM_CHOICES[spec.key]
      const inputs: string[] = choices ? [...choices, 'definitely-not-valid'] : spec.key === 'enableWeb' ? [] : ['some-text']
      for (const raw of inputs) {
        const fromCli = envOverridesFrom({ [cliName]: raw }, 'cli')
        const fromVite = envOverridesFrom({ [viteName]: raw }, 'vite')
        expect(fromVite, `${spec.key} = ${raw}`).toEqual(fromCli)
      }
    }
  })

  it('treats a boolean the same on both surfaces, each with its own literal (decision D6)', () => {
    expect(envOverridesFrom({ ASSISTANT_ENABLE_WEB: '1' }, 'cli')).toEqual({ enableWeb: true })
    expect(envOverridesFrom({ ASSISTANT_ENABLE_WEB: 'true' }, 'cli')).toEqual({ enableWeb: false })
    expect(envOverridesFrom({ VITE_ASSISTANT_ENABLE_WEB: 'true' }, 'vite')).toEqual({ enableWeb: true })
    expect(envOverridesFrom({ VITE_ASSISTANT_ENABLE_WEB: '1' }, 'vite')).toEqual({ enableWeb: false })
  })

  it('accepts every documented choice and falls back to a documented choice for a typo, for each enum key', () => {
    quiet()
    for (const spec of ENV_KEYS) {
      const choices = ENUM_CHOICES[spec.key]
      if (!choices || !spec.cli) continue
      for (const choice of choices) expect(envOverridesFrom({ [spec.cli]: choice }, 'cli'), `${spec.key} = ${choice}`).toEqual({ [spec.key]: choice })
      const typo = envOverridesFrom({ [spec.cli]: 'not-a-mode' }, 'cli')[spec.key] as string
      expect(choices, spec.key).toContain(typo)
    }
  })

  it('names the variable in the warning for a typo, per surface', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    envOverridesFrom({ ASSISTANT_ONE_LOOP: 'maybe' }, 'cli')
    envOverridesFrom({ VITE_ASSISTANT_ONE_LOOP: 'maybe' }, 'vite')
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('ASSISTANT_ONE_LOOP'), expect.stringContaining('VITE_ASSISTANT_ONE_LOOP')])
  })
})

describe('"set" differs by surface on purpose', () => {
  it('the CLI counts an empty variable as set, a Vite build counts it as unset', () => {
    expect(envOverridesFrom({ ASSISTANT_PROXY_URL: '' }, 'cli')).toEqual({ proxyUrl: '' })
    expect(envOverridesFrom({ VITE_ASSISTANT_PROXY_URL: '' }, 'vite')).toEqual({})
    expect(envOverridesFrom({}, 'cli')).toEqual({})
  })
  it('a display-only name is never read from the Vite environment', () => {
    expect(envOverridesFrom({ ASSISTANT_LLM_BACKEND: 'openai' }, 'vite')).toEqual({})
    expect(envOverridesFrom({ ASSISTANT_LLM_BACKEND: 'openai' }, 'cli')).toEqual({ llmBackend: 'openai' })
  })
  it('the web backend only exists on the Vite surface; a bad value is ignored with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(envOverridesFrom({ VITE_ASSISTANT_WEB_BACKEND: 'proxy' }, 'vite')).toEqual({ webBackend: 'proxy' })
    expect(envOverridesFrom({ VITE_ASSISTANT_WEB_BACKEND: 'weird' }, 'vite')).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('shared value parsers', () => {
  it('normalizeLlmBackend keeps a known backend and sends anything else to proxy', () => {
    for (const b of ['claude-cli', 'anthropic', 'openai', 'openrouter'] as const) expect(normalizeLlmBackend(b)).toBe(b)
    expect(normalizeLlmBackend('claud-cli')).toBe('proxy')
  })
  it('parseShellNetworkAllowlist trims and drops empties', () => {
    expect(parseShellNetworkAllowlist(' a.com, ,b.org ,')).toEqual(['a.com', 'b.org'])
  })
  it('formatChoices words two and three choices', () => {
    expect(formatChoices(['a', 'b'])).toBe('"a" or "b"')
    expect(formatChoices(['a', 'b', 'c'])).toBe('"a", "b" or "c"')
  })
})

describe('/config set uses the same choices', () => {
  it('accepts each choice and rejects a word outside it, naming the choices', () => {
    for (const [key, choices] of Object.entries(ENUM_CHOICES)) {
      for (const choice of choices ?? []) expect(parseConfigValue(key as never, choice)).toBe(choice)
      expect(() => parseConfigValue(key as never, 'nope')).toThrow(ConfigValueParseError)
      expect(() => parseConfigValue(key as never, 'nope')).toThrow(formatChoices(choices ?? []))
    }
  })
})
