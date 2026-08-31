'use client'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4">
      <div className="w-full max-w-md rounded-[2rem] border border-white/70 bg-white/72 p-8 text-center shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-700/70">
          Master Plan Dashboard
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
          Something went wrong
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          This screen hit an unexpected error. It&apos;s not something you
          did — try again, and if it keeps happening let us know.
        </p>

        <button
          onClick={() => reset()}
          className="mt-6 rounded-2xl bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)] px-5 py-3 text-sm font-medium text-white shadow-lg transition hover:-translate-y-[1px]"
        >
          Try again
        </button>

        <details className="mt-6 text-left">
          <summary className="cursor-pointer text-xs font-medium text-slate-400 hover:text-slate-500">
            Technical details
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ''}
          </pre>
        </details>
      </div>
    </main>
  )
}
