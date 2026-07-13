import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between px-8 py-4 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Trading Hub
        </span>
        <div className="flex items-center gap-3">
          <SignedOut>
            <SignInButton>
              <button className="rounded-full border border-zinc-300 dark:border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton>
              <button className="rounded-full bg-zinc-900 dark:bg-zinc-50 px-4 py-1.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-200 transition-colors">
                Sign up
              </button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <Link
              href="/dashboard"
              className="rounded-full border border-zinc-300 dark:border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Dashboard
            </Link>
            <UserButton />
          </SignedIn>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 text-center px-8">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          AI-Powered Crypto Trading
        </h1>
        <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
          Real-time signals, automated execution, and multi-exchange support — all in one platform.
        </p>
        <SignedOut>
          <SignUpButton>
            <button className="rounded-full bg-zinc-900 dark:bg-zinc-50 px-6 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-200 transition-colors">
              Get started
            </button>
          </SignUpButton>
        </SignedOut>
        <SignedIn>
          <Link
            href="/dashboard"
            className="rounded-full bg-zinc-900 dark:bg-zinc-50 px-6 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-200 transition-colors"
          >
            Go to Dashboard
          </Link>
        </SignedIn>
      </main>
    </div>
  );
}
