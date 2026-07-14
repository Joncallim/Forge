import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/hooks/useSession";
import { ThemeProvider } from "@/hooks/useTheme";
import { Toaster } from "@/components/ui/sonner";

const metadataBase = new URL(
  process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000",
);

export const metadata: Metadata = {
  applicationName: "FORGE",
  metadataBase,
  title: "FORGE",
  description:
    "Self-hosted AI coding orchestration dashboard for Orchestrator-led software engineering workflows.",
  icons: {
    icon: [
      { url: "/brand/forge-favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    shortcut: "/brand/forge-favicon.svg",
    apple: "/brand/forge-app-icon.svg",
  },
  openGraph: {
    title: "FORGE",
    description: "A local control room for coordinated AI coding work.",
    images: [
      {
        url: "/brand/forge-og.png",
        width: 1200,
        height: 630,
        alt: "FORGE — many specialists, one coordinated system",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "FORGE",
    description: "A local control room for coordinated AI coding work.",
    images: ["/brand/forge-og.png"],
  },
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
