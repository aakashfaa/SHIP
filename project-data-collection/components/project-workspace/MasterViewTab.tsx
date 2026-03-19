import { Project } from '@/lib/types'

type Props = {
  project: Project
}

export default function MasterViewTab({ project }: Props) {
  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-gray-50 p-5">
        <p className="text-sm text-gray-500">Master View</p>
        <h3 className="mt-1 text-2xl font-semibold text-gray-900">
          Combined Project Data
        </h3>
        <p className="mt-3 text-sm text-gray-600">
          This becomes the single merged project dataset after consultant inputs
          and admin data are brought together.
        </p>
      </div>

      <div className="rounded-3xl bg-gray-50 p-5">
        <p className="text-sm text-gray-500">Current Structure Preview</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {project.consultants.map((consultant) => (
            <div key={consultant.type} className="rounded-2xl bg-white px-4 py-4">
              <div className="flex items-center justify-between">
                <span className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white">
                  {consultant.type}
                </span>
                <span className="text-xs text-gray-400">
                  {consultant.emails.length} contacts
                </span>
              </div>
              <p className="mt-3 text-base font-semibold text-gray-900">
                {consultant.orgName}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}