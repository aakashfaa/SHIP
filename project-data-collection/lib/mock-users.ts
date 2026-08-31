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
  {
    email: 'planning@atlasmech.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Atlas MEP',
  },
  {
    email: 'structural@coredesign.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Core Design Structures',
  },
  {
    email: 'electrical@voltworks.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Volt Works',
  },
  {
    email: 'civil@terrainlab.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Terrain Lab',
  },
  {
    email: 'historic@heritagestudio.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Heritage Studio',
  },
  {
    email: 'access@openpath.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Open Path',
  },
  {
    email: 'landscape@fieldoffice.com',
    password: 'consultant123',
    role: 'consultant',
    name: 'Field Office',
  },
]
