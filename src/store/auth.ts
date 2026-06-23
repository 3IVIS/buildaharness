/**
 * Auth store — JWT management.
 *
 * Fix #11: The token is now stored in ONE place only: the Zustand persist blob
 * ('buildaharness:auth'). The old pattern wrote it to BOTH 'buildaharness:auth' AND
 * 'buildaharness:token', creating two sources of truth with potential divergence
 * after a crash or logout race.
 *
 * api.ts reads the token from this store's in-memory state directly via
 * getAuthToken() rather than polling localStorage.
 *
 * isReady note: localStorage is a synchronous storage backend. Zustand v4's
 * persist middleware uses a synchronous thenable internally, so hydration
 * completes before any React component renders. isReady therefore starts as
 * true and onRehydrateStorage is not needed.
 *
 * The previous approach tried to set isReady inside onRehydrateStorage, but
 * that callback fires during create() — while `useAuthStore` is still in the
 * temporal dead zone — causing a ReferenceError on startup.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { api } from '../services/api'

interface AuthState {
  token:   string | null
  userId:  string | null
  email:   string | null
  /** Always true for synchronous localStorage storage; kept for API compatibility. */
  isReady: boolean

  login:    (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout:   () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token:   null,
      userId:  null,
      email:   null,
      isReady: true,

      login: async (email, password) => {
        const res = await api.auth.login(email, password)
        set({ token: res.token, userId: res.user_id, email: res.email })
      },

      register: async (email, password) => {
        const res = await api.auth.register(email, password)
        set({ token: res.token, userId: res.user_id, email: res.email })
      },

      logout: () => {
        set({ token: null, userId: null, email: null })
      },
    }),
    {
      name:       'buildaharness:auth',
      storage:    createJSONStorage(() => localStorage),
      partialize: (s) => ({ token: s.token, userId: s.userId, email: s.email }),
    },
  ),
)

/**
 * Fix #11: single accessor for the current auth token.
 * api.ts calls this instead of reading localStorage directly.
 */
export function getAuthToken(): string | null {
  return useAuthStore.getState().token
}
