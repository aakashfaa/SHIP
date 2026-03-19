import { UserRole } from './types'

export type MockUser = {
  email: string
  password: string
  role: UserRole
  name: string
}

export const SEED_USERS: MockUser[] = [
  {
    email: 'admin@gmail.com',
    password: 'admin123',
    role: 'admin',
    name: 'Admin User',
  },
  {
    email: 'consultant1@gmail.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Consultant One',
  },
  {
    email: 'consultant2@gmail.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Consultant Two',
  },
]