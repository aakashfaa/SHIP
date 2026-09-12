'use client'

import { useId } from 'react'
import type { DependencyType } from '@/lib/types'

/**
 * The dependency-link overlay.
 *
 * One absolutely-positioned SVG spanning the whole grid, one path per link.
 * `pointer-events: none` on the surface so it never steals the pointer events
 * the drag/resize handlers depend on; individual paths opt back in so a link
 * can be selected and deleted.
 *
 * Routing is orthogonal ("Manhattan"), not straight diagonals. That is the
 * convention in every scheduling tool for a practical reason: across a grid
 * fifteen columns wide and a dozen rows tall, diagonal lines are impossible to
 * trace back to their origin, while right-angled ones read as wiring.
 */

export type ArrowRect = {
  /** Pixel left edge of the bar, relative to the SVG's origin. */
  x: number
  y: number
  width: number
  height: number
}

export type ArrowLink = {
  id: string
  depType: DependencyType
  lagSlots: number
  predecessor: ArrowRect
  successor: ArrowRect
  /** Drawn in the violation colour and given a title the user can read. */
  violated?: boolean
}

/** Horizontal stub length leaving a bar before the first turn. */
const STUB = 14
/** Corner radius on the elbows. Purely legibility — square corners read as
 *  noise where several links converge on one bar. */
const RADIUS = 6

type Point = { x: number; y: number }

/**
 * Turns a polyline into an SVG path, rounding the interior corners.
 *
 * Each interior vertex is approached to within `RADIUS`, curved through with a
 * quadratic whose control point IS the vertex, then left at `RADIUS` on the
 * far side. `Math.sign` picks the direction per axis, so this works for any
 * combination of up/down/left/right without special cases.
 *
 * The radius is clamped to half the shorter adjoining segment, otherwise a
 * short segment between two turns produces overlapping curves that render as a
 * visible kink.
 */
function roundedPolyline(points: Point[], radius: number): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`

  let d = `M ${points[0].x} ${points[0].y}`

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]

    const inLength = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const outLength = Math.hypot(next.x - cur.x, next.y - cur.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)

    if (r <= 0.5) {
      d += ` L ${cur.x} ${cur.y}`
      continue
    }

    const inX = cur.x - Math.sign(cur.x - prev.x) * r
    const inY = cur.y - Math.sign(cur.y - prev.y) * r
    const outX = cur.x + Math.sign(next.x - cur.x) * r
    const outY = cur.y + Math.sign(next.y - cur.y) * r

    d += ` L ${inX} ${inY} Q ${cur.x} ${cur.y} ${outX} ${outY}`
  }

  const last = points[points.length - 1]
  return `${d} L ${last.x} ${last.y}`
}

/**
 * Where a link leaves its predecessor and where it enters its successor.
 *
 * This is the part that actually encodes link semantics rather than geometry.
 * FS and FF leave the predecessor's FINISH edge; SS and SF leave its START
 * edge. FS and SS enter the successor's START edge; FF and SF enter its FINISH
 * edge. Getting this wrong draws a plausible-looking arrow that means something
 * other than what the data says.
 */
function anchors(link: ArrowLink) {
  const { predecessor: p, successor: s, depType } = link

  const leavesFinish = depType === 'FS' || depType === 'FF'
  const entersStart = depType === 'FS' || depType === 'SS'

  return {
    from: {
      x: leavesFinish ? p.x + p.width : p.x,
      y: p.y + p.height / 2,
      /** +1 if the path should initially head right, -1 for left. */
      dir: leavesFinish ? 1 : -1,
    },
    to: {
      x: entersStart ? s.x : s.x + s.width,
      y: s.y + s.height / 2,
      /** The arrowhead points this way into the bar. */
      dir: entersStart ? 1 : -1,
    },
  }
}

function linkPath(link: ArrowLink): string {
  const { from, to } = anchors(link)

  const exitX = from.x + STUB * from.dir
  const entryX = to.x - STUB * to.dir

  // Forward case: there is room to turn once between the two bars, so the path
  // is the familiar out-across-down-in shape.
  const hasRoom = to.dir === 1 ? entryX >= exitX : entryX <= exitX

  if (hasRoom) {
    const midX = (exitX + entryX) / 2
    return roundedPolyline(
      [
        { x: from.x, y: from.y },
        { x: midX, y: from.y },
        { x: midX, y: to.y },
        { x: to.x, y: to.y },
      ],
      RADIUS
    )
  }

  // Backward case: the successor starts before the predecessor ends, which
  // happens constantly the moment someone drags a bar earlier than its links
  // allow. A straight run would pass through both bars, so route around them
  // via a lane below whichever sits lower.
  //
  // This is the case people forget, and its absence looks like a rendering bug
  // rather than a scheduling one — which is exactly when a user most needs the
  // arrow to be legible, because the link is about to be flagged as violated.
  const laneY = Math.max(from.y, to.y) + Math.max(link.predecessor.height, link.successor.height) / 2 + 12

  return roundedPolyline(
    [
      { x: from.x, y: from.y },
      { x: exitX, y: from.y },
      { x: exitX, y: laneY },
      { x: entryX, y: laneY },
      { x: entryX, y: to.y },
      { x: to.x, y: to.y },
    ],
    RADIUS
  )
}

type Props = {
  links: ArrowLink[]
  width: number
  height: number
  onSelectLink?: (linkId: string) => void
}

export default function DependencyArrows({ links, width, height, onSelectLink }: Props) {
  // `useId` rather than a module constant: two timelines on one page (a
  // scenario compared against the baseline, later) would otherwise share a
  // marker id, and the second would silently re-use the first's colour.
  const rawId = useId()
  const markerId = `dep-arrow-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const violatedMarkerId = `${markerId}-violated`

  if (links.length === 0) return null

  return (
    <svg
      className="pointer-events-none absolute left-0 top-0 z-10 overflow-visible"
      width={width}
      height={height}
      aria-hidden="true"
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
        </marker>
        <marker
          id={violatedMarkerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#e11d48" />
        </marker>
      </defs>

      {links.map((link) => {
        const d = linkPath(link)
        const stroke = link.violated ? '#e11d48' : '#475569'
        const lagSuffix =
          link.lagSlots === 0 ? '' : link.lagSlots > 0 ? ` +${link.lagSlots}` : ` ${link.lagSlots}`

        return (
          <g key={link.id}>
            {/* A wide transparent stroke under the visible one. A 1.5px line is
                almost impossible to click; this gives it a realistic hit area
                without changing how it looks. */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={12}
              className={onSelectLink ? 'pointer-events-stroke cursor-pointer' : undefined}
              onClick={onSelectLink ? () => onSelectLink(link.id) : undefined}
            />
            <path
              d={d}
              fill="none"
              stroke={stroke}
              strokeWidth={1.5}
              strokeDasharray={link.violated ? '5 3' : undefined}
              markerEnd={`url(#${link.violated ? violatedMarkerId : markerId})`}
            >
              <title>
                {link.depType}
                {lagSuffix}
                {link.violated ? ' — not satisfied by the current schedule' : ''}
              </title>
            </path>
          </g>
        )
      })}
    </svg>
  )
}
