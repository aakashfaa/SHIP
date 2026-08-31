import { ChunkProject, ProjectTimelineSettings } from './types'

export const SEED_CHUNK_PROJECTS: ChunkProject[] = [
  {
    id: 'seed-chunk-001',
    projectId: 'federal-campus-master-plan',
    chunkNumber: 'PP10',
    name: 'Infrastructure Stabilization',
    itemLinks: [
      { lineItemId: 'seed-li-002', quantity: '1' },
      { lineItemId: 'seed-li-003', quantity: '1' },
      { lineItemId: 'seed-li-004', quantity: '1' },
    ],
    timelineSegments: [
      { id: 'seed-chunk-001-a', start: 0, duration: 4 },
      { id: 'seed-chunk-001-b', start: 8, duration: 2 },
    ],
    timelineStart: 0,
    timelineDuration: 4,
    createdAt: '2026-04-01T12:00:00.000Z',
  },
  {
    id: 'seed-chunk-002',
    projectId: 'federal-campus-master-plan',
    chunkNumber: 'PP11',
    name: 'Envelope and Preservation',
    itemLinks: [
      { lineItemId: 'seed-li-006', quantity: '1' },
      { lineItemId: 'seed-li-003', quantity: '0.5' },
    ],
    timelineSegments: [{ id: 'seed-chunk-002-a', start: 2, duration: 5 }],
    timelineStart: 2,
    timelineDuration: 5,
    createdAt: '2026-04-01T12:10:00.000Z',
  },
  {
    id: 'seed-chunk-003',
    projectId: 'federal-campus-master-plan',
    chunkNumber: 'PP12',
    name: 'Campus Site Resilience',
    itemLinks: [
      { lineItemId: 'seed-li-001', quantity: '1' },
      { lineItemId: 'seed-li-005', quantity: '1' },
      { lineItemId: 'seed-li-008', quantity: '1' },
    ],
    timelineSegments: [{ id: 'seed-chunk-003-a', start: 5, duration: 3 }],
    timelineStart: 5,
    timelineDuration: 3,
    createdAt: '2026-04-01T12:20:00.000Z',
  },
  {
    id: 'seed-chunk-004',
    projectId: 'federal-campus-master-plan',
    chunkNumber: 'PP13',
    name: 'Interior Access and Restack',
    itemLinks: [
      { lineItemId: 'seed-li-007', quantity: '1' },
      { lineItemId: 'seed-li-009', quantity: '1' },
      { lineItemId: 'seed-li-010', quantity: '1' },
      { lineItemId: 'seed-li-011', quantity: '1' },
    ],
    timelineSegments: [
      { id: 'seed-chunk-004-a', start: 1, duration: 2 },
      { id: 'seed-chunk-004-b', start: 6, duration: 4 },
    ],
    timelineStart: 1,
    timelineDuration: 2,
    createdAt: '2026-04-01T12:30:00.000Z',
  },
  {
    id: 'seed-chunk-005',
    projectId: 'federal-campus-master-plan',
    chunkNumber: 'PP14',
    name: 'Public Meeting Center',
    itemLinks: [{ lineItemId: 'seed-li-012', quantity: '1' }],
    timelineSegments: [{ id: 'seed-chunk-005-a', start: 10, duration: 3 }],
    timelineStart: 10,
    timelineDuration: 3,
    createdAt: '2026-04-01T12:40:00.000Z',
  },
]

export const SEED_TIMELINE_SETTINGS: ProjectTimelineSettings[] = [
  {
    projectId: 'federal-campus-master-plan',
    years: 15,
    interval: 'yearly',
    zoomLevel: 3,
    escalationPercent: 0,
    escalationEveryYears: 5,
  },
]
