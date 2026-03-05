import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="mb-4 text-4xl font-bold">QVAC Documentation</h1>
      <p className="mb-8 text-lg text-muted-foreground">
        SDK, API, and product documentation.
      </p>
      <Link
        href="/docs"
        className="rounded-lg bg-primary px-6 py-3 text-primary-foreground hover:opacity-90"
      >
        Go to Docs
      </Link>
    </main>
  );
}
