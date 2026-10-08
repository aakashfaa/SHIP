'use client'

import { motion } from 'framer-motion'

export type WorkspaceNavTab<K extends string> = {
  key: K
  label: string
  /** Rendered as a small circular icon button rather than a labelled pill. */
  iconOnly?: boolean
}

type WorkspaceNavProps<K extends string> = {
  tabs: WorkspaceNavTab<K>[]
  activeTab: K
  onSelect: (key: K) => void
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-[18px] w-[18px]" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

/**
 * The floating tab bar.
 *
 * `data-workspace-nav` exists for the screenshot harness, not for styling.
 * This bar is position:fixed, so in a Playwright fullPage capture it renders
 * at whatever the scroll offset happened to be when the shot was taken --
 * which varies run to run and produced a diff that looked exactly like a
 * layout regression. The visual tests hide it by this attribute; see
 * tests/helpers/screenshot.css.
 */
export default function WorkspaceNav<K extends string>({
  tabs,
  activeTab,
  onSelect,
}: WorkspaceNavProps<K>) {
  return (
    <div
      data-workspace-nav
      className="no-print fixed bottom-6 left-1/2 z-50 w-[94%] max-w-3xl -translate-x-1/2"
    >
      <div className="flex items-center gap-1 rounded-[2rem] border border-white/70 bg-white/74 p-2 shadow-[0_24px_70px_rgba(15,23,42,0.16)] backdrop-blur-2xl">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key

          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onSelect(tab.key)}
              // The icon-only entry sizes to its glyph; the labelled ones share
              // what is left. Both carry the same layoutId pill: its 1.4rem
              // radius is half the 44px icon button, so one class reads as a
              // circle there and a pill elsewhere and the move animates cleanly.
              className={`relative flex items-center justify-center ${
                tab.iconOnly ? 'h-11 w-11 shrink-0' : 'flex-1 px-2 py-3'
              }`}
              aria-label={tab.label}
              aria-current={isActive ? 'page' : undefined}
              title={tab.label}
            >
              {isActive ? (
                <motion.div
                  layoutId="active-tab-pill"
                  className="absolute inset-0 rounded-[1.4rem] bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_45%,#0f766e_100%)]"
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              ) : null}

              <motion.span
                animate={{
                  scale: isActive ? 1.03 : 1,
                  opacity: isActive ? 1 : 0.74,
                }}
                transition={{ duration: 0.18 }}
                className={`relative z-10 flex items-center justify-center text-xs font-medium md:text-sm ${
                  isActive ? 'text-white' : 'text-slate-700'
                }`}
              >
                {tab.iconOnly ? <GearIcon /> : tab.label}
              </motion.span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
