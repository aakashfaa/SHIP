import { SafeUser } from './types'
import { getStoredUsers } from './store'

const STORAGE_KEY = 'pdc_current_user'

export function loginUser(email: string, password: string): SafeUser | null {
  const users = getStoredUsers()

  const user = users.find(
    (u) => u.email === email.trim().toLowerCase() && u.password === password
  )

  if (!user) return null

  const safeUser: SafeUser = {
    email: user.email,
    role: user.role,
    name: user.name,
  }

  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeUser))
  }

  return safeUser
}

export function getCurrentUser(): SafeUser | null {
  if (typeof window === 'undefined') return null

  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null

  try {
    return JSON.parse(raw) as SafeUser
  } catch {
    return null
  }
}

export function logoutUser() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY)
  }
}