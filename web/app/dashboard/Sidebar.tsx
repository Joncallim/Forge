'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  FolderOpenIcon,
  ListTodoIcon,
  ServerIcon,
  BotIcon,
  SettingsIcon,
  LogOutIcon,
  HammerIcon,
} from 'lucide-react'
import { useSession } from '@/hooks/useSession'
import { Button } from '@/components/ui/button'
import { SidebarTaskStatus } from './SidebarTaskStatus'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { href: '/dashboard/projects', label: 'Projects', icon: FolderOpenIcon },
  { href: '/dashboard/tasks', label: 'Tasks', icon: ListTodoIcon },
  { href: '/dashboard/mcps', label: 'MCP tools', icon: ServerIcon },
  { href: '/dashboard/providers', label: 'Providers', icon: ServerIcon },
  { href: '/dashboard/agents', label: 'Agents', icon: BotIcon },
  { href: '/dashboard/settings', label: 'Settings', icon: SettingsIcon },
] as const

interface NavLinkProps {
  href: string
  label: string
  icon: React.ElementType
  onClick?: () => void
}

function NavLink({ href, label, icon: Icon, onClick }: NavLinkProps) {
  const pathname = usePathname()
  const isActive = pathname === href || pathname.startsWith(href + '/')
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
    </Link>
  )
}

export function DesktopSidebar() {
  const { user, logout } = useSession()

  return (
    <aside
      className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-2 border-r border-sidebar-border bg-sidebar px-3 py-4 md:flex"
      aria-label="Main navigation"
    >
      {/* Branding */}
      <div className="mb-2 flex shrink-0 items-center gap-2 px-3 py-2">
        <HammerIcon className="size-5 text-sidebar-primary" aria-hidden="true" />
        <span className="text-base font-semibold text-sidebar-foreground">Forge</span>
      </div>

      {/* Nav links — scroll internally if they ever exceed the viewport so the
          status strip and logout below always stay visible. */}
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} {...item} />
        ))}
      </nav>

      {/* Ongoing-task status strip */}
      <div className="mt-auto shrink-0 pt-3">
        <SidebarTaskStatus />
      </div>

      {/* User + logout */}
      <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t border-sidebar-border pt-3">
        <span className="truncate text-sm text-sidebar-foreground" title={user?.displayName}>
          {user?.displayName ?? '—'}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={logout}
          aria-label="Log out"
          title="Log out"
        >
          <LogOutIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </aside>
  )
}

interface MobileNavProps {
  onClose: () => void
}

export function MobileNav({ onClose }: MobileNavProps) {
  const { user, logout } = useSession()

  return (
    <div className="flex h-full flex-col gap-2 px-3 py-4">
      {/* Branding */}
      <div className="mb-2 flex items-center gap-2 px-3 py-2">
        <HammerIcon className="size-5 text-sidebar-primary" aria-hidden="true" />
        <span className="text-base font-semibold text-sidebar-foreground">Forge</span>
      </div>

      {/* Nav links */}
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} {...item} onClick={onClose} />
        ))}
      </nav>

      {/* Ongoing-task status strip */}
      <div className="mt-auto shrink-0 pt-3">
        <SidebarTaskStatus />
      </div>

      {/* User + logout */}
      <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t border-sidebar-border pt-3">
        <span className="truncate text-sm text-sidebar-foreground" title={user?.displayName}>
          {user?.displayName ?? '—'}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={async () => { onClose(); await logout() }}
          aria-label="Log out"
          title="Log out"
        >
          <LogOutIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

export function BottomTabBar() {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 flex border-t border-sidebar-border bg-sidebar md:hidden"
      aria-label="Bottom navigation"
    >
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
        <BottomTab key={href} href={href} label={label} icon={Icon} />
      ))}
    </nav>
  )
}

function BottomTab({ href, label, icon: Icon }: { href: string; label: string; icon: React.ElementType }) {
  const pathname = usePathname()
  const isActive = pathname === href || pathname.startsWith(href + '/')
  return (
    <Link
      href={href}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'flex flex-1 flex-col items-center gap-1 py-2 text-xs font-medium transition-colors',
        isActive
          ? 'text-sidebar-primary'
          : 'text-muted-foreground hover:text-sidebar-accent-foreground',
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span>{label}</span>
    </Link>
  )
}
