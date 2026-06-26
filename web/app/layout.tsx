import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/hooks/useSession";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Forge",
  description:
    "Self-hosted AI coding orchestration dashboard for Orchestrator-led software engineering workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
          <SessionProvider>{children}</SessionProvider>
          <Toaster />
        </body>
    </html>
  );
}
