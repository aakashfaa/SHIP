export default function Loading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(45,212,191,0.18),_transparent_28%),linear-gradient(180deg,_#fffdf7_0%,_#f8fafc_50%,_#eef2f7_100%)] px-4">
      <div className="flex flex-col items-center gap-4 rounded-[2rem] border border-white/70 bg-white/72 px-10 py-8 text-center shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full w-1/3 animate-[loading-bar_1.2s_ease-in-out_infinite] rounded-full bg-[linear-gradient(90deg,#0f172a,#0f766e)]" />
        </div>
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
      <style>{`
        @keyframes loading-bar {
          0% { transform: translateX(-120%); }
          100% { transform: translateX(340%); }
        }
      `}</style>
    </main>
  )
}
