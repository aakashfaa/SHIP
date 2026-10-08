/**
 * PDF export for a table view (Master View): opens a print window holding
 * exactly the given columns and rows, and prints it.
 *
 * Not ExportBar's in-place `window.print()`: a wide matrix inside the
 * workspace's scrolling box would print clipped to that box. The rows are
 * rebuilt from data rather than cloned from the on-screen table, so edit-mode
 * inputs and sticky-column styling never reach the PDF.
 *
 * M-20: the document is built with DOM APIs only -- every value goes in via
 * textContent, never an HTML string, so a project or answer containing an
 * <img onerror=...> tag prints as text instead of running in this origin.
 */

import type { ReportCellValue, ReportColumn } from './line-item-cells'

export type PrintableTable = {
  title: string
  subtitle?: string
  columns: ReportColumn[]
  rows: ReportCellValue[][]
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })
const CURRENCY_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function cellText(column: ReportColumn, value: ReportCellValue | undefined): string {
  if (value === undefined || value === '') return ''
  if (typeof value === 'number') {
    return column.format === 'currency' ? CURRENCY_FORMAT.format(value) : NUMBER_FORMAT.format(value)
  }
  return value
}

/** Returns false when the browser blocked the popup. */
export function printTable(table: PrintableTable): boolean {
  // Same-origin about:blank, detached from us (opener = null) before anything
  // is written; the 'noopener' feature can't be used because it makes
  // window.open return null and we need the handle to fill the document.
  const printWindow = window.open('', '_blank', 'width=1500,height=900')
  if (!printWindow) return false
  printWindow.opener = null

  const doc = printWindow.document
  doc.title = table.title

  const style = doc.createElement('style')
  style.textContent = `
    @page { size: landscape; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    p { font-size: 10px; color: #64748b; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 9px; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    th, td { border: 1px solid #dbe1ea; padding: 4px 5px; vertical-align: top; word-break: break-word; text-align: left; }
    th { background: #e2e8f0; text-transform: uppercase; letter-spacing: .04em; font-size: 8px; }
    td.multi { white-space: pre-line; }
    td.num { text-align: right; white-space: nowrap; }
  `
  doc.head.appendChild(style)

  const heading = doc.createElement('h1')
  heading.textContent = table.title
  doc.body.appendChild(heading)
  if (table.subtitle) {
    const subtitle = doc.createElement('p')
    subtitle.textContent = table.subtitle
    doc.body.appendChild(subtitle)
  }

  const tableEl = doc.createElement('table')
  const headRow = doc.createElement('tr')
  for (const column of table.columns) {
    const th = doc.createElement('th')
    th.textContent = column.header
    headRow.appendChild(th)
  }
  const thead = doc.createElement('thead')
  thead.appendChild(headRow)

  const tbody = doc.createElement('tbody')
  for (const row of table.rows) {
    const tr = doc.createElement('tr')
    table.columns.forEach((column, index) => {
      const td = doc.createElement('td')
      const value = row[index]
      // A grouped cell's lines (Op / User / Public) stay on their own lines.
      if (typeof value === 'number') td.className = 'num'
      else if (column.wrap) td.className = 'multi'
      td.textContent = cellText(column, value)
      tr.appendChild(td)
    })
    tbody.appendChild(tr)
  }

  tableEl.append(thead, tbody)
  doc.body.appendChild(tableEl)

  printWindow.focus()
  printWindow.print()
  return true
}
