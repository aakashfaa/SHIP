import { Project, ConsultantType } from './types'

export const CONSULTANT_TYPES: ConsultantType[] = [
  'Architecture',
  'Accessibility',
  'Civil',
  'Electrical',
  'Envelope',
  'Fire Alarm',
  'Hazardous Materials',
  'Historic Preservation',
  'Landscape',
  'Mechanical',
  'Plumbing',
  'Structural',
  'Security',
  'Telecom',
]

export const SEED_PROJECTS: Project[] = [
  {
    id: 'library-renovation',
    name: 'Boston Library Renovation',
    createdAt: '2026-03-10',
    assignedUsers: ['consultant1@gmail.com'],
    consultants: [
      {
        type: 'Architecture',
        orgName: 'FAA',
        emails: ['admin@gmail.com'],
      },
      {
        type: 'Mechanical',
        orgName: 'North MEP Studio',
        emails: ['mep@northstudio.com'],
      },
      {
        type: 'Structural',
        orgName: 'FrameWorks Engineering',
        emails: ['team@frameworks.com', 'lead@frameworks.com'],
      },
    ],
  },
  {
    id: 'school-modernization',
    name: 'School Modernization Package',
    createdAt: '2026-03-12',
    assignedUsers: ['consultant2@gmail.com'],
    consultants: [
      {
        type: 'Architecture',
        orgName: 'FAA',
        emails: ['admin@gmail.com'],
      },
      {
        type: 'Electrical',
        orgName: 'Volt Systems',
        emails: ['info@voltsystems.com'],
      },
      {
        type: 'Accessibility',
        orgName: 'Access Forward',
        emails: ['review@accessforward.com'],
      },
    ],
  },
  {
    id: 'federal-campus-master-plan',
    name: 'Federal Campus Master Plan',
    createdAt: '2026-04-01',
    assignedUsers: [
      'planning@atlasmech.com',
      'structural@coredesign.com',
      'electrical@voltworks.com',
      'civil@terrainlab.com',
      'historic@heritagestudio.com',
    ],
    consultants: [
      {
        type: 'Architecture',
        orgName: 'FAA',
        emails: ['admin@gmail.com'],
      },
      {
        type: 'Mechanical',
        orgName: 'Atlas MEP',
        emails: ['planning@atlasmech.com'],
      },
      {
        type: 'Structural',
        orgName: 'Core Design Structures',
        emails: ['structural@coredesign.com'],
      },
      {
        type: 'Electrical',
        orgName: 'Volt Works',
        emails: ['electrical@voltworks.com'],
      },
      {
        type: 'Civil',
        orgName: 'Terrain Lab',
        emails: ['civil@terrainlab.com'],
      },
      {
        type: 'Historic Preservation',
        orgName: 'Heritage Studio',
        emails: ['historic@heritagestudio.com'],
      },
      {
        type: 'Accessibility',
        orgName: 'Open Path',
        emails: ['access@openpath.com'],
      },
      {
        type: 'Landscape',
        orgName: 'Field Office',
        emails: ['landscape@fieldoffice.com'],
      },
    ],
  },
]
