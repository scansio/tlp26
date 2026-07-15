import { DocsSidebar } from './_components/docs-sidebar';

export const metadata = {
  title: 'Docs — Trading Hub',
  description: 'Learn how to use Trading Hub: AI-powered crypto trading signals, risk management, and multi-exchange execution.',
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <DocsSidebar />
      <main className="lg:pl-56 min-h-screen">
        <div className="max-w-3xl mx-auto px-6 py-12 lg:py-16">
          {children}
        </div>
      </main>
    </div>
  );
}
