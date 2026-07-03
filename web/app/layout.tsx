import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/hooks/useSession";
import { ThemeProvider } from "@/hooks/useTheme";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Forge",
  description:
    "Self-hosted AI coding orchestration dashboard for Orchestrator-led software engineering workflows.",
};

// Applies the persisted appearance theme before first paint so the page never
// flashes the wrong mode/accent. Kept in sync with hooks/useTheme.tsx.
const themeInitScript = `(function(){try{var m=localStorage.getItem('forge-theme-mode')||'system';var a=localStorage.getItem('forge-theme-accent')||'default';var dark=m==='dark'||(m==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',dark);r.dataset.accent=a;}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
          <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
          <ThemeProvider>
            <SessionProvider>{children}</SessionProvider>
          </ThemeProvider>
          <Toaster />
        </body>
    </html>
  );
}
