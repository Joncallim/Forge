import type { ReactNode } from 'react'
import { DesktopSidebar, BottomTabBar } from './Sidebar'
import { MobileHeader } from './MobileHeader'

interface DashboardLayoutProps {
  children: ReactNode
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="flex h-full min-h-screen flex-col md:flex-row">
      {/* Desktop sidebar */}
      <DesktopSidebar />

      {/* Mobile top bar (hamburger + branding) */}
      <MobileHeader />

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
        {children}
      </main>

      {/* Mobile bottom tab bar */}
      <BottomTabBar />
    </div>
  )
}
