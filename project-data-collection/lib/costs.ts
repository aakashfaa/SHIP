export function parseCostInput(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[$,\s]/g, '')
  if (!normalized) return 0

  const suffix = normalized.slice(-1)
  const multiplier =
    suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1
  const numeric = multiplier === 1 ? normalized : normalized.slice(0, -1)
  const parsed = Number.parseFloat(numeric)

  return Number.isFinite(parsed) ? parsed * multiplier : 0
}

export function parseQuantityInput(value: string) {
  const normalized = value.trim()
  if (!normalized) return 1

  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value)
}
