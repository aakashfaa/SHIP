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
]