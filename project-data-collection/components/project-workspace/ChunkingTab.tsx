export default function ChunkingTab() {
  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-gray-50 p-5">
        <p className="text-sm text-gray-500">Chunking</p>
        <h3 className="mt-1 text-2xl font-semibold text-gray-900">
          Break Into Smaller Project Pieces
        </h3>
        <p className="mt-3 text-sm text-gray-600">
          Split the whole project into smaller scopes, packages, zones, phases,
          or discipline-based chunks.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {['By Phase', 'By Building', 'By Floor', 'By Discipline'].map((item) => (
          <div key={item} className="rounded-3xl bg-gray-50 p-5">
            <p className="text-sm font-medium text-gray-900">{item}</p>
            <p className="mt-2 text-sm text-gray-500">
              Chunking mode placeholder.
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}