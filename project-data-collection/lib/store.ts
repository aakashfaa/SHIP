import { SEED_PROJECTS } from './mock-projects'
import { MockUser, SEED_USERS } from './mock-users'
import { ConsultantType, Project, ProjectConsultant } from './types'

const PROJECTS_KEY = 'pdc_projects'
const USERS_KEY = 'pdc_users'

const DEFAULT_CONSULTANT_PASSWORD = 'welcome123'

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))]
}

export function getDefaultConsultantPassword() {
  return DEFAULT_CONSULTANT_PASSWORD
}

export function getStoredUsers(): MockUser[] {
  if (typeof window === 'undefined') return SEED_USERS

  const raw = localStorage.getItem(USERS_KEY)
  if (!raw) return SEED_USERS

  try {
    const parsed = JSON.parse(raw) as MockUser[]
    return [...SEED_USERS, ...parsed]
  } catch {
    return SEED_USERS
  }
}

export function saveStoredUsers(users: MockUser[]) {
  if (typeof window === 'undefined') return

  const seedEmails = new Set(SEED_USERS.map((u) => u.email.toLowerCase()))
  const customUsers = users.filter((u) => !seedEmails.has(u.email.toLowerCase()))
  localStorage.setItem(USERS_KEY, JSON.stringify(customUsers))
}

export function getStoredProjects(): Project[] {
  if (typeof window === 'undefined') return SEED_PROJECTS

  const raw = localStorage.getItem(PROJECTS_KEY)
  if (!raw) return SEED_PROJECTS

  try {
    const parsed = JSON.parse(raw) as Project[]
    return parsed
  } catch {
    return SEED_PROJECTS
  }
}

export function saveStoredProjects(projects: Project[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
}

export function ensureConsultantUsers(emails: string[]) {
  const allUsers = getStoredUsers()
  const existingEmails = new Set(allUsers.map((u) => u.email.toLowerCase()))

  const newUsers: MockUser[] = []

  uniqueStrings(emails).forEach((email) => {
    if (!existingEmails.has(email)) {
      const baseName = email.split('@')[0] || 'Consultant'
      const niceName = baseName
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())

      newUsers.push({
        email,
        password: DEFAULT_CONSULTANT_PASSWORD,
        role: 'consultant',
        name: niceName,
      })
    }
  })

  if (newUsers.length > 0) {
    saveStoredUsers([...allUsers, ...newUsers])
  }

  return newUsers
}

export function createProject(input: {
  name: string
  consultants: ProjectConsultant[]
}) {
  const projects = getStoredProjects()

  const baseId = slugify(input.name) || 'new-project'
  let candidateId = baseId
  let counter = 2

  while (projects.some((p) => p.id === candidateId)) {
    candidateId = `${baseId}-${counter}`
    counter += 1
  }

  const consultantEmails = uniqueStrings(
    input.consultants.flatMap((consultant) => consultant.emails)
  )

  const assignedUsers = consultantEmails.filter(
    (email) => email.toLowerCase() !== 'admin@gmail.com'
  )

  const newProject: Project = {
    id: candidateId,
    name: input.name.trim(),
    createdAt: new Date().toISOString().slice(0, 10),
    consultants: input.consultants.map((consultant) => ({
      ...consultant,
      emails: uniqueStrings(consultant.emails),
    })),
    assignedUsers,
  }

  saveStoredProjects([newProject, ...projects])

  const newUsers = ensureConsultantUsers(assignedUsers)

  return {
    project: newProject,
    newUsers,
  }
}

export function updateProject(projectId: string, updates: Partial<Project>) {
  const projects = getStoredProjects()

  const updatedProjects = projects.map((project) => {
    if (project.id !== projectId) return project

    const updatedConsultants = updates.consultants
      ? updates.consultants.map((consultant) => ({
          ...consultant,
          emails: uniqueStrings(consultant.emails),
        }))
      : project.consultants

    const assignedUsers = uniqueStrings(
      updatedConsultants
        .flatMap((consultant) => consultant.emails)
        .filter((email) => email !== 'admin@gmail.com')
    )

    return {
      ...project,
      ...updates,
      consultants: updatedConsultants,
      assignedUsers,
    }
  })

  saveStoredProjects(updatedProjects)

  const updatedProject = updatedProjects.find((p) => p.id === projectId)
  if (!updatedProject) return null

  const newUsers = ensureConsultantUsers(updatedProject.assignedUsers)

  return {
    project: updatedProject,
    newUsers,
  }
}

export function addConsultantToProject(
  projectId: string,
  consultant: ProjectConsultant
) {
  const project = getStoredProjects().find((p) => p.id === projectId)
  if (!project) return null

  const alreadyExists = project.consultants.some((c) => c.type === consultant.type)
  if (alreadyExists) return null

  return updateProject(projectId, {
    consultants: [...project.consultants, consultant],
  })
}

export function removeConsultantFromProject(
  projectId: string,
  consultantType: ConsultantType
) {
  const project = getStoredProjects().find((p) => p.id === projectId)
  if (!project) return null

  return updateProject(projectId, {
    consultants: project.consultants.filter((c) => c.type !== consultantType),
  })
}

import { LineItem } from './types'

const LINE_ITEMS_KEY = 'pdc_line_items'

function getDisciplinePrefix(discipline: string) {
  const cleaned = discipline.trim().toUpperCase()

  const specialMap: Record<string, string> = {
    ARCHITECTURE: 'A',
    ACCESSIBILITY: 'AC',
    CIVIL: 'C',
    ELECTRICAL: 'E',
    ENVELOPE: 'EN',
    'FIRE ALARM': 'FA',
    'HAZARDOUS MATERIALS': 'HM',
    'HISTORIC PRESERVATION': 'HP',
    LANDSCAPE: 'L',
    MECHANICAL: 'M',
    PLUMBING: 'P',
    STRUCTURAL: 'S',
    SECURITY: 'SE',
    TELECOM: 'T',
    ADMIN: 'AD',
  }

  if (specialMap[cleaned]) return specialMap[cleaned]

  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length === 1) return words[0].slice(0, 2)
  return words.slice(0, 2).map((w) => w[0]).join('')
}

function getNextItemNumber(discipline: string) {
  const items = getStoredLineItems()
  const prefix = getDisciplinePrefix(discipline)

  const matching = items.filter((item) => item.discipline === discipline)

  return `${prefix}${matching.length + 1}`
}

export function getStoredLineItems(): LineItem[] {
  if (typeof window === 'undefined') return []

  const raw = localStorage.getItem(LINE_ITEMS_KEY)
  if (!raw) return []

  try {
    return JSON.parse(raw) as LineItem[]
  } catch {
    return []
  }
}

export function saveStoredLineItems(items: LineItem[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(LINE_ITEMS_KEY, JSON.stringify(items))
}

export function getLineItemsForProjectUser(projectId: string, userEmail: string) {
  return getStoredLineItems()
    .filter((item) => item.projectId === projectId && item.userEmail === userEmail)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
}

export function deleteLineItem(lineItemId: string) {
  const items = getStoredLineItems()
  const updated = items.filter((item) => item.id !== lineItemId)
  saveStoredLineItems(updated)
}

function getCompanyNameForUser(project: Project, userEmail: string, discipline: string) {
  if (discipline === 'Admin') return 'FAA'

  const consultant = project.consultants.find(
    (c) => c.type === discipline && c.emails.includes(userEmail)
  )

  if (consultant?.orgName) return consultant.orgName

  const fallbackConsultant = project.consultants.find((c) =>
    c.emails.includes(userEmail)
  )

  return fallbackConsultant?.orgName || 'Unknown Organization'
}

export function createLineItem(
  input: Omit<LineItem, 'id' | 'createdAt' | 'companyName' | 'discipline' | 'itemNumber'>,
  project: Project
) {
  const normalizedDiscipline =
    input.consultantType === 'Admin' ? 'Architecture' : input.consultantType

  const companyName =
    input.consultantType === 'Admin'
      ? 'FAA'
      : getCompanyNameForUser(project, input.userEmail, normalizedDiscipline)

  const itemNumber = getNextItemNumber(normalizedDiscipline)

  const items = getStoredLineItems()

  const newItem: LineItem = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    companyName,
    discipline: normalizedDiscipline,
    itemNumber,
  }

  const updated = [...items, newItem]
  saveStoredLineItems(updated)

  return newItem
}

export function getLineItemsForProject(projectId: string) {
  return getStoredLineItems().filter((item) => item.projectId === projectId)
}

import { ChunkProject } from './types'

const CHUNK_PROJECTS_KEY = 'pdc_chunk_projects'

export function getStoredChunkProjects(): ChunkProject[] {
  if (typeof window === 'undefined') return []

  const raw = localStorage.getItem(CHUNK_PROJECTS_KEY)
  if (!raw) return []

  try {
    return JSON.parse(raw) as ChunkProject[]
  } catch {
    return []
  }
}

export function saveStoredChunkProjects(projects: ChunkProject[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(CHUNK_PROJECTS_KEY, JSON.stringify(projects))
}

export function getChunkProjectsForProject(projectId: string) {
  return getStoredChunkProjects()
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}

export function getNextChunkNumber(projectId: string) {
  const existing = getChunkProjectsForProject(projectId)

  const usedNumbers = existing
    .map((item) => {
      const match = item.chunkNumber.match(/^PP(\d+)$/)
      return match ? Number(match[1]) : null
    })
    .filter((v): v is number => v !== null)

  const next = usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 10
  return `PP${next}`
}

export function createChunkProject(input: { projectId: string; name: string }) {
  const all = getStoredChunkProjects()

  const newChunk: ChunkProject = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    chunkNumber: getNextChunkNumber(input.projectId),
    name: input.name.trim(),
    itemLinks: [],
    createdAt: new Date().toISOString(),
  }

  saveStoredChunkProjects([...all, newChunk])
  return newChunk
}

export function updateChunkProject(chunkId: string, updates: Partial<ChunkProject>) {
  const all = getStoredChunkProjects()

  const updated = all.map((chunk) =>
    chunk.id === chunkId ? { ...chunk, ...updates } : chunk
  )

  saveStoredChunkProjects(updated)
  return updated.find((chunk) => chunk.id === chunkId) || null
}

export function deleteChunkProject(chunkId: string) {
  const all = getStoredChunkProjects()
  saveStoredChunkProjects(all.filter((chunk) => chunk.id !== chunkId))
}

export function addLineItemToChunkProject(chunkId: string, lineItemId: string) {
  const all = getStoredChunkProjects()

  const updated = all.map((chunk) => {
    if (chunk.id !== chunkId) return chunk

    const alreadyExists = chunk.itemLinks.some((link) => link.lineItemId === lineItemId)
    if (alreadyExists) return chunk

    return {
      ...chunk,
      itemLinks: [...chunk.itemLinks, { lineItemId, quantity: '' }],
    }
  })

  saveStoredChunkProjects(updated)
  return updated.find((chunk) => chunk.id === chunkId) || null
}

export function removeLineItemFromChunkProject(chunkId: string, lineItemId: string) {
  const all = getStoredChunkProjects()

  const updated = all.map((chunk) => {
    if (chunk.id !== chunkId) return chunk

    return {
      ...chunk,
      itemLinks: chunk.itemLinks.filter((link) => link.lineItemId !== lineItemId),
    }
  })

  saveStoredChunkProjects(updated)
  return updated.find((chunk) => chunk.id === chunkId) || null
}

export function updateChunkProjectItemQuantity(
  chunkId: string,
  lineItemId: string,
  quantity: string
) {
  const all = getStoredChunkProjects()

  const updated = all.map((chunk) => {
    if (chunk.id !== chunkId) return chunk

    return {
      ...chunk,
      itemLinks: chunk.itemLinks.map((link) =>
        link.lineItemId === lineItemId ? { ...link, quantity } : link
      ),
    }
  })

  saveStoredChunkProjects(updated)
  return updated.find((chunk) => chunk.id === chunkId) || null
}