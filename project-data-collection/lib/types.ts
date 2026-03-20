export type UserRole = 'admin' | 'consultant'

export type ConsultantType =
  | 'Architecture'
  | 'Accessibility'
  | 'Civil'
  | 'Electrical'
  | 'Envelope'
  | 'Fire Alarm'
  | 'Hazardous Materials'
  | 'Historic Preservation'
  | 'Landscape'
  | 'Mechanical'
  | 'Plumbing'
  | 'Structural'
  | 'Security'
  | 'Telecom'

export type SafeUser = {
  email: string
  role: UserRole
  name: string
}

export type ProjectConsultant = {
  type: ConsultantType
  orgName: string
  emails: string[]
}

export type Project = {
  id: string
  name: string
  consultants: ProjectConsultant[]
  assignedUsers: string[]
  createdAt: string
}

export type LineItemCategory =
  | 'END OF LIFE'
  | 'DEFERRED MAINTENANCE'
  | 'UPGRADES / IMPROVEMENTS'
  | 'RESTORATION *'
  | 'STUDY / DOCUMENTATION'

export type TimelinePriority =
  | '0_PRIORITY *'
  | '1_HIGH <5 years'
  | '2_MID 5-10 years'
  | '3_LOW 10-20 years'
  | '4_FUTURE >20 years'
  | '5_250th ANNIVERSARY'

export type BuildingAreaImpacted =
  | 'WHOLE BUILDING'
  | 'ANNEX'
  | 'WEST WING'
  | 'EAST WING'
  | 'BULFINCH'
  | 'SITE'
  | 'OTHER *'

export type BuildingLevelImpacted =
  | 'WHOLE BUILDING'
  | 'ROOF'
  | 'ENVELOPE (EXT. WALLS)'
  | 'LEVELS ABOVE GRADE'
  | 'LEVELS BELOW GRADE'
  | 'L5'
  | 'L4'
  | 'L3'
  | 'L2'
  | 'L1'
  | 'BASEMENT'
  | 'SUB BASEMENT'
  | 'OTHER *'

export type RelativeImpact = 'NONE' | 'LOW' | 'MODERATE' | 'HIGH'

export type RelativeFirstCost = '$LOW' | '$$Moderate' | '$$$High'

export type RelativeOperationCostImpact =
  | 'MINIMAL IMPACT'
  | 'MODERATE REDUCTION'
  | 'HIGH REDUCTION'
  | 'INCREASE'
  | 'N/A'

export type RelativeOperationalEnergyUsage =
  | 'MINIMAL IMPACT'
  | 'MODERATE REDUCTION'
  | 'HIGH REDUCTION'
  | 'N/A'

export type BooleanChoice = 'Yes' | 'No'

export type LineItem = {
  id: string
  projectId: string
  userEmail: string
  consultantType: ConsultantType | 'Admin'
  companyName: string
  discipline: ConsultantType | 'Admin'
  itemNumber: string
  name: string
  shortDescription: string
  category: LineItemCategory
  timelinePriority: TimelinePriority
  buildingAreaImpacted: BuildingAreaImpacted
  buildingLevelImpacted: BuildingLevelImpacted
  operationalImpact: RelativeImpact
  benefitToUsers: RelativeImpact
  benefitToPublic: RelativeImpact
  relativeFirstCost: RelativeFirstCost
  relativeOperationCostImpact: RelativeOperationCostImpact
  relativeOperationalEnergyUsage: RelativeOperationalEnergyUsage
  electrificationEO594: RelativeImpact
  addressingResiliencySustainability: BooleanChoice
  addressingDeferredMaintenance: BooleanChoice
  codeLifeSafetyImprovement: BooleanChoice
  accessibilityImprovement: BooleanChoice
  historicImpact: BooleanChoice
  potentialSynergies: ConsultantType[]
  supportingNotes: string
  createdAt: string
}

export type ChunkProjectItem = {
  lineItemId: string
  quantity: string
}

export type ChunkProject = {
  id: string
  projectId: string
  chunkNumber: string
  name: string
  itemLinks: ChunkProjectItem[]
  createdAt: string
}