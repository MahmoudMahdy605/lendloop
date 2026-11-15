"use client";

import { Show, SignInButton } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { categoryLabel } from "@/lib/categories";

export default function Home() {
  const tools = useQuery(api.tools.listPublic);

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <header className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight">LendLoop</h1>
        <p className="mt-2 text-lg text-stone-600">Borrow what you need. Lend what you don&apos;t.</p>
        <div className="mt-6">
          <Show when="signed-out">
            <SignInButton mode="modal" forceRedirectUrl="/app">
              <button className="rounded-lg bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800">
                Sign in to lend or borrow
              </button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link href="/app" className="rounded-lg bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800">
              Open your dashboard
            </Link>
          </Show>
        </div>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">Available in the neighborhood</h2>
        {tools === undefined ? (
          <p className="text-stone-500">Loading…</p>
        ) : tools.length === 0 ? (
          <p className="text-stone-500">No tools listed yet. Be the first.</p>
        ) : (
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
            {tools.map((t) => (
              <li key={t._id} className="flex items-center justify-between px-4 py-3">
                <span className="font-medium">{t.name}</span>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">{categoryLabel(t.category)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
