import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-16 items-center justify-between px-6 lg:px-12">
        <div className="flex items-center gap-2 font-serif text-xl font-semibold text-primary">
          <svg viewBox="0 0 100 100" className="h-8 w-8" fill="none">
            <circle cx="50" cy="50" r="45" fill="#E8F3E8"/>
            <path d="M50 85 C50 85 45 60 50 40" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
            <path d="M50 40 C35 35 30 50 50 55 C70 50 65 35 50 40" fill="currentColor"/>
            <circle cx="50" cy="40" r="6" fill="#F4A261"/>
            <path d="M50 60 C40 60 30 75 50 80 C70 75 60 60 50 60" fill="#40916C"/>
          </svg>
          Wildflower Schools
        </div>
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-sm font-medium hover:text-primary">
            Sign In
          </Link>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-4 text-center">
        <div className="max-w-3xl space-y-8">
          <h1 className="font-serif text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            A purpose-built CRM for <span className="text-primary">fundraisers.</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground sm:text-xl">
            Track donors, manage pipelines, log moves, and forecast revenue. Built exclusively for the Wildflower development team.
          </p>
          <div className="flex justify-center">
            <Link href="/sign-in" className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              Go to Dashboard
            </Link>
          </div>
        </div>
      </main>

      <footer className="border-t py-6 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} Wildflower Schools. All rights reserved.
      </footer>
    </div>
  );
}
