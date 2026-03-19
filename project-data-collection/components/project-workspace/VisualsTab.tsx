export default function VisualsTab() {
  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-gray-50 p-5">
        <p className="text-sm text-gray-500">Visuals</p>
        <h3 className="mt-1 text-2xl font-semibold text-gray-900">
          Visual View of Project Chunks
        </h3>
        <p className="mt-3 text-sm text-gray-600">
          Show chunked packages in a more visual, spatial, and digestible way
          through cards, grouped views, diagrams, or future graph interfaces.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {['Chunk A', 'Chunk B', 'Chunk C'].map((item) => (
          <div
            key={item}
            className="rounded-[1.75rem] bg-gray-50 p-5 shadow-sm"
          >
            <div className="h-28 rounded-[1.25rem] bg-white" />
            <p className="mt-4 text-base font-semibold text-gray-900">{item}</p>
            <p className="mt-1 text-sm text-gray-500">
              Visual chunk card placeholder.
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}