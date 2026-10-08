// Excel export route (spec R8.1). Multi-sheet, flat-values, zero-formula
// `.xlsx` — see lib/export/excel.ts and lib/export/report-data.ts for the
// actual sheet construction and the commercial constraint (R8.3) on what
// may appear in it. This file's only jobs are: authenticate, verify the
// caller can actually read the project, build the buffer, and stream it
// back with the right headers.
//
// `runtime = 'nodejs'` because exceljs needs Buffer/streams, which the Edge
// runtime does not provide. `dynamic = 'force-dynamic'` because this reads
// per-request cookies (via createSupabaseServerClient) and per-project data
// that changes constantly — it must never be cached or prerendered.
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { buildExcelBuffer } from '@/lib/export/excel'
import {
  ExportBlockedError,
  buildProjectReportData,
  fetchProjectForExport,
} from '@/lib/export/report-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function slugifyFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'project'
}

// Next.js 16: `params` is a Promise even for Route Handlers — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md.
// Typed by hand rather than via the generated `RouteContext<'...'>` helper,
// which only exists after `next build`/`next dev`/`next typegen` have run
// and would make a clean-checkout `tsc --noEmit` fail.
type RouteParams = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: projectId } = await params

  // M-24: `?scenario=<id>` exports the what-if the user is looking at, priced
  // through the same overlay as the screen. Absent = the live plan. The id is
  // only a lookup key: the scenario row is read through RLS below, so a
  // private what-if belonging to someone else is "not found", not exported.
  const scenarioId = request.nextUrl.searchParams.get('scenario')?.trim() || null

  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // This is the load-bearing authorization check. `fetchProjectForExport`
  // runs on the request-scoped, cookie-bound client from
  // lib/supabase/server.ts — the SAME client every other query in this
  // route uses — so every read below is filtered by RLS as this specific
  // user. There is no service-role client anywhere in this file: a route
  // that bypassed RLS to read the project would be a data leak, not a
  // convenience. A project that does not exist and a project this user
  // cannot read are indistinguishable here, exactly as they are in
  // app/projects/[id]/page.tsx, and both collapse to 404.
  const project = await fetchProjectForExport(supabase, projectId)
  if (!project) {
    return NextResponse.json(
      { error: 'Project not found, or you do not have access to it.' },
      { status: 404 }
    )
  }

  // R8.4: a viewer cannot export, full stop — not "cannot export unless they
  // know the URL". The button that calls this route is already hidden for
  // viewers (MasterViewTab, TimelineTab), but hiding a control is a UI
  // courtesy, not authorization: a viewer who types this URL, or replays a
  // captured request, is READABLE per RLS (that's what let them past the
  // 404 above) and would otherwise walk straight out with the workbook.
  // `project_role` is the same RPC the client reads its own role from
  // (lib/project-role.ts), run here on the request-scoped server client so
  // it resolves against this actual caller rather than anything client-sent.
  const { data: role, error: roleError } = await supabase.rpc('project_role', {
    p_project_id: projectId,
  })
  if (roleError || role === 'viewer' || role === null) {
    return NextResponse.json(
      { error: 'Viewers cannot export this project.' },
      { status: 403 }
    )
  }

  let buffer: Buffer
  let scenarioName: string | null = null
  try {
    const reportData = await buildProjectReportData(supabase, project, { scenarioId })
    buffer = await buildExcelBuffer(reportData)
    scenarioName = reportData.scenario?.name ?? null
  } catch (error) {
    // Missing base/start year (M-25) or a scenario that isn't there (M-24):
    // a specific, fixable reason -- say it, with its own status, not a 500.
    if (error instanceof ExportBlockedError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    const message = error instanceof Error ? error.message : 'Failed to build export'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const filename = scenarioName
    ? `${slugifyFilename(project.name)}-scenario-${slugifyFilename(scenarioName)}-export.xlsx`
    : `${slugifyFilename(project.name)}-export.xlsx`

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
