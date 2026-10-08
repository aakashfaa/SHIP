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
import type { ProjectReportData, ReportCellValue } from './report-data'

const CURRENCY_FORMAT = '$#,##0'
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF0F172A' },
}
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } }

const BANNER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FF7C2D12' } }
const BANNER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFEF3C7' },
}

type ColumnSpec<T> = {
  header: string
  width: number
  currency?: boolean
  value: (row: T) => string | number | boolean
}

/**
 * One line above the header on every sheet when the workbook needs to say
 * something the numbers can't: which what-if it prices (M-24 -- a scenario
 * workbook must never pass for the live plan once it is detached from the
 * app), and any unreadable costs/quantities counted as zero (M-09/M-10).
 * Sheet NAMES stay fixed ("Packages", ...) -- Excel forbids ':' in them and
 * caps them at 31 characters, so "Scenario: X" can't go there; it goes in
 * this banner, the workbook title and the file name instead.
 */
function bannerText(data: ProjectReportData): string | null {
  return data.notices.length > 0 ? data.notices.join('  ') : null
}

function addSheet<T>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: ColumnSpec<T>[],
  rows: readonly T[],
  banner: string | null
): void {
  const sheet = workbook.addWorksheet(name)

  sheet.columns = columns.map((col) => ({ width: col.width }))

  if (banner) {
    const bannerRow = sheet.addRow([banner])
    bannerRow.getCell(1).font = BANNER_FONT
    bannerRow.getCell(1).fill = BANNER_FILL
    if (columns.length > 1) sheet.mergeCells(bannerRow.number, 1, bannerRow.number, columns.length)
  }

  const headerRow = sheet.addRow(columns.map((col) => col.header))
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
  })

  // Frozen header (and banner): stays visible as a client scrolls through
  // what can be a few hundred line items.
  sheet.views = [{ state: 'frozen', ySplit: headerRow.number }]

  for (const row of rows) {
    const values = columns.map((col) => col.value(row))
    const addedRow = sheet.addRow(values)

    columns.forEach((col, index) => {
      // Only numbers get the currency format; an "Unreadable" marker in a
      // money column stays visibly text.
      if (col.currency && typeof values[index] === 'number') {
        addedRow.getCell(index + 1).numFmt = CURRENCY_FORMAT
      }
    })
  }
}

export function buildExcelWorkbook(data: ProjectReportData): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'SHIP'
  workbook.created = new Date(data.generatedAt)
  workbook.title = data.scenario
    ? `${data.project.name} — scenario: ${data.scenario.name} — export`
    : `${data.project.name} — export`

  const banner = bannerText(data)

  // Columns come from the project's form definition (M-28) -- see
  // buildLineItemTable in report-data.ts. Each row is already in column order.
  addSheet<ReportCellValue[]>(
    workbook,
    'Line Items',
    data.lineItems.columns.map((column, index) => ({
      header: column.header,
      width: column.width,
      currency: column.format === 'currency',
      value: (row) => row[index] ?? '',
    })),
    data.lineItems.rows,
    banner
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
    data.packages,
    banner
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
      { header: 'Start Month', width: 14, value: (r) => r.startMonth },
      { header: 'Duration (months)', width: 18, value: (r) => r.durationMonths },
      { header: 'Duration (years)', width: 16, value: (r) => r.durationYears },
      { header: 'Locked', width: 10, value: (r) => (r.durationLocked ? 'Yes' : 'No') },
      { header: 'Cost', width: 18, currency: true, value: (r) => r.escalatedCost },
    ],
    data.phases,
    banner
  )

  addSheet(
    workbook,
    'Annual Cost Summary',
    [
      { header: 'Fiscal Year', width: 14, value: (r) => r.fiscalYearLabel },
      // Fiscal quarters (D-11), split month by month like the total: Q1 is
      // the fiscal year's first three months (Jul-Sep for a July year).
      { header: 'Q1', width: 16, currency: true, value: (r) => r.quarterTotals[0] },
      { header: 'Q2', width: 16, currency: true, value: (r) => r.quarterTotals[1] },
      { header: 'Q3', width: 16, currency: true, value: (r) => r.quarterTotals[2] },
      { header: 'Q4', width: 16, currency: true, value: (r) => r.quarterTotals[3] },
      { header: 'Total Cost', width: 18, currency: true, value: (r) => r.escalatedTotal },
    ],
    data.annualCostSummary,
    banner
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
    data.energySummary,
    banner
  )

  return workbook
}

export async function buildExcelBuffer(data: ProjectReportData): Promise<Buffer> {
  const workbook = buildExcelWorkbook(data)
  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
