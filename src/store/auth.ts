import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { api } from '../services/api'

interface AuthState {
  token:   string | null
  userId:  string | null
  email:   string | null
  /** true once the persisted store has been rehydrated */
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
      isReady: false,

      login: async (email, password) => {
        const res = await api.auth.login(email, password)
        // Also write token to plain localStorage so authHeaders() in api.ts picks it up
        localStorage.setItem('itsharness:token', res.token)
        set({ token: res.token, userId: res.user_id, email: res.email })
      },

      register: async (email, password) => {
        const res = await api.auth.register(email, password)
        localStorage.setItem('itsharness:token', res.token)
        set({ token: res.token, userId: res.user_id, email: res.email })
      },

      logout: () => {
        localStorage.removeItem('itsharness:token')
        set({ token: null, userId: null, email: null })
      },
    }),
    {
      name:       'itsharness:auth',
      storage:    createJSONStorage(() => localStorage),
      partialize: (s) => ({ token: s.token, userId: s.userId, email: s.email }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Sync persisted token into the raw key api.ts reads
          if (state.token) localStorage.setItem('itsharness:token', state.token)
          state.isReady = true
        }
      },
    },
  ),
)
