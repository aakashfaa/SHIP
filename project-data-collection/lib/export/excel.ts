/**
 * The Excel export: a multi-sheet, flat-values-only `.xlsx` workbook.
 *
 * "would you want the Excel file to still have the formulas that we're
 *  using in the backend, or do you just want it to be a flat data sheet?"
 *  / "I think flat data is fine." — Aakash, Megan
 *
 * Every cell here is a literal value written with `cell.value = <number |
 * string>`. NEVER set `cell.value = { formula: ... }` (or any of exceljs'
 * other formula forms) anywhere in this file — that is the one thing this
 * export is explicitly not allowed to be. The number itself comes from
 * `lib/export/report-data.ts`, which in turn comes only from
 * `lib/cost-model.ts`; this module's only job is to lay numbers that are
 * already final onto a sheet.
 *
 * See `lib/export/report-data.ts`'s header for the commercial constraint
 * (spec R8.3) on which figures may appear at all — this file must not
 * "helpfully" add a cost-parameter column that report-data.ts left out.
 */

import ExcelJS from 'exceljs'
import type { ProjectReportData } from './report-data'

const CURRENCY_FORMAT = '$#,##0'
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF0F172A' },
}
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } }

type ColumnSpec<T> = {
  header: string
  width: number
  currency?: boolean
  value: (row: T) => string | number | boolean
}

function addSheet<T>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: ColumnSpec<T>[],
  rows: readonly T[]
): void {
  const sheet = workbook.addWorksheet(name)

  sheet.columns = columns.map((col) => ({
    header: col.header,
    width: col.width,
  }))

  const headerRow = sheet.getRow(1)
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
  })

  // Frozen header: the header row stays visible as a client scrolls
  // through what can be a few hundred line items.
  sheet.views = [{ state: 'frozen', ySplit: 1 }]

  for (const row of rows) {
    const values = columns.map((col) => col.value(row))
    const addedRow = sheet.addRow(values)

    columns.forEach((col, index) => {
      if (col.currency) {
        addedRow.getCell(index + 1).numFmt = CURRENCY_FORMAT
      }
    })
  }
}

export function buildExcelWorkbook(data: ProjectReportData): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'SHIP'
  workbook.created = new Date(data.generatedAt)
  workbook.title = `${data.project.name} — export`

  addSheet(
    workbook,
    'Line Items',
    [
      { header: 'Item #', width: 10, value: (r) => r.itemNumber },
      { header: 'Name', width: 32, value: (r) => r.name },
      { header: 'Discipline', width: 18, value: (r) => r.discipline },
      { header: 'Company', width: 20, value: (r) => r.companyName },
      { header: 'Category', width: 24, value: (r) => r.category },
      { header: 'Timeline Priority', width: 20, value: (r) => r.timelinePriority },
      { header: 'Building Area', width: 16, value: (r) => r.buildingAreaImpacted },
      { header: 'Building Level', width: 20, value: (r) => r.buildingLevelImpacted },
      { header: 'Relative First Cost', width: 16, value: (r) => r.relativeFirstCost },
      { header: 'Estimated First Cost', width: 18, value: (r) => r.estimatedFirstCost },
      {
        header: 'ECC Amount',
        width: 16,
        currency: true,
        value: (r) => r.eccAmount,
      },
      { header: 'Annual Energy Savings', width: 20, value: (r) => r.annualEnergySavings },
      {
        header: 'Annual Cost Savings',
        width: 18,
        currency: true,
        value: (r) => r.annualCostSavings,
      },
      { header: 'Energy Notes', width: 28, value: (r) => r.energyNotes },
      { header: 'Supporting Notes', width: 28, value: (r) => r.supportingNotes },
    ],
    data.lineItems
  )

  addSheet(
    workbook,
    'Packages',
    [
      { header: 'Package #', width: 12, value: (r) => r.chunkNumber },
      { header: 'Package Name', width: 32, value: (r) => r.name },
      { header: 'Phases', width: 10, value: (r) => r.phaseCount },
      { header: 'Total Cost', width: 18, currency: true, value: (r) => r.totalCost },
      {
        header: 'Annual Energy Savings',
        width: 20,
        value: (r) => r.energySavingsAnnual,
      },
      {
        header: 'Annual Cost Savings',
        width: 18,
        currency: true,
        value: (r) => r.annualCostSavings,
      },
      {
        header: 'Fully Scheduled',
        width: 16,
        value: (r) => (r.allocationIsIncomplete ? 'No' : 'Yes'),
      },
    ],
    data.packages
  )

  addSheet(
    workbook,
    'Phase Schedule',
    [
      { header: 'Package #', width: 12, value: (r) => r.chunkNumber },
      { header: 'Package Name', width: 28, value: (r) => r.packageName },
      { header: 'Phase Name', width: 32, value: (r) => r.phaseName },
      { header: 'Kind', width: 14, value: (r) => r.kind },
      { header: 'Start (Fiscal Year)', width: 18, value: (r) => r.startFiscalYear },
      { header: 'Duration (years)', width: 16, value: (r) => r.durationYears },
      { header: 'Locked', width: 10, value: (r) => (r.durationLocked ? 'Yes' : 'No') },
      { header: 'Cost', width: 18, currency: true, value: (r) => r.escalatedCost },
    ],
    data.phases
  )

  addSheet(
    workbook,
    'Annual Cost Summary',
    [
      { header: 'Fiscal Year', width: 14, value: (r) => r.fiscalYearLabel },
      { header: 'Total Cost', width: 18, currency: true, value: (r) => r.escalatedTotal },
    ],
    data.annualCostSummary
  )

  addSheet(
    workbook,
    'Energy Summary',
    [
      { header: 'Fiscal Year', width: 14, value: (r) => r.fiscalYear },
      {
        header: `Cumulative Savings (${data.energyUnitLabel})`,
        width: 26,
        value: (r) => r.cumulativeSavings,
      },
      {
        header:
          data.energyBaselineAnnual !== null
            ? `Remaining Consumption (${data.energyUnitLabel})`
            : 'Remaining Consumption (no baseline set)',
        width: 30,
        value: (r) => r.remainingConsumption ?? '',
      },
    ],
    data.energySummary
  )

  return workbook
}

export async function buildExcelBuffer(data: ProjectReportData): Promise<Buffer> {
  const workbook = buildExcelWorkbook(data)
  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
