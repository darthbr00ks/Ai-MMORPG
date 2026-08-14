import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI World — New Concord',
  description: 'A persistent civilization of autonomous AI characters.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <nav className="border-b border-gray-800 px-6 py-3 flex items-center justify-between">
          <h1 className="text-xl font-bold text-amber-400">⚔️ AI World — New Concord</h1>
          <div className="flex gap-4 text-sm">
            <a href="/" className="hover:text-amber-400">Dashboard</a>
            <a href="/characters" className="hover:text-amber-400">Characters</a>
            <a href="/spectate" className="hover:text-amber-400">Spectate</a>
            <a href="/admin" className="hover:text-amber-400">Admin</a>
          </div>
        </nav>
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
