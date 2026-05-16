import { useState, type FormEvent } from 'react'
import { useAuthStore } from '../store/auth'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { token, isReady, login, register } = useAuthStore()

  const [mode,     setMode]     = useState<'login' | 'register'>('login')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  // Still rehydrating from localStorage
  if (!isReady) return null

  // Already authenticated — render the app
  if (token) return <>{children}</>

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'login') await login(email, password)
      else                  await register(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: 'var(--bg-base)',
    }}>
      <div style={{
        width: 360, background: 'var(--bg-raised)',
        border: '0.5px solid var(--border-mid)',
        borderRadius: 12, padding: '28px 28px 24px',
      }}>
        {/* Logo / title */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            itsharness
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {mode === 'login' ? 'Sign in to your workspace' : 'Create your workspace'}
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="field">
            <label className="field__label">Email</label>
            <input
              className="field__input"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="field">
            <label className="field__label">Password</label>
            <input
              className="field__input"
              type="password"
              placeholder={mode === 'register' ? 'At least 8 characters' : ''}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <div style={{
              fontSize: 11.5, color: '#f87171',
              background: 'rgba(248,113,113,0.08)',
              border: '0.5px solid rgba(248,113,113,0.25)',
              borderRadius: 6, padding: '7px 10px',
            }}>
              {error}
            </div>
          )}

          <button
            className="btn btn--primary"
            type="submit"
            disabled={loading}
            style={{ width: '100%', justifyContent: 'center', marginTop: 4, padding: '9px 0' }}
          >
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#60a5fa', fontSize: 'inherit', padding: 0 }}
          >
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  )
}
