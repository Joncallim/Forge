'use client'

import { useState } from 'react'
import { MenuIcon, HammerIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from '@/components/ui/sheet'
import { MobileNav } from './Sidebar'

export function MobileHeader() {
  const [open, setOpen] = useState(false)

  return (
    <header className="flex items-center gap-3 border-b border-border bg-background px-4 py-3 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-controls="mobile-nav-sheet"
          onClick={() => setOpen(true)}
        >
          <MenuIcon className="size-5" aria-hidden="true" />
        </Button>

        <SheetContent side="left" id="mobile-nav-sheet" aria-label="Navigation menu">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <MobileNav onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex items-center gap-2">
        <HammerIcon className="size-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">Forge</span>
      </div>
    </header>
  )
}
