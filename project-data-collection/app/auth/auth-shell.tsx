'use client'

// Shared look for the small auth screens (sign-up, forgot password, set
// password). Matches the sign-in card on `/` so every step of getting in
// feels like the same product. Not a route: only page.tsx / route.ts files
// under app/ are routable.

export const PAGE_SHELL =
  'flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4 py-8'

export const CARD =
  'w-full max-w-md rounded-[2rem] border border-white/70 bg-white/76 p-8 shadow-[0_30px_100px_rgba(15,23,42,0.16)] backdrop-blur-2xl'

export const INPUT =
  'w-full rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100'

export const PRIMARY_BUTTON =
  'w-full rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px] disabled:opacity-50'

export const SECONDARY_BUTTON =
  'w-full rounded-2xl border border-slate-200 bg-white/60 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-white/90 disabled:opacity-50'

export function Eyebrow() {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-800">
      Master Plan Dashboard
    </p>
  )
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
    >
      {children}
    </div>
  )
}

export function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
    >
      {children}
    </div>
  )
}
