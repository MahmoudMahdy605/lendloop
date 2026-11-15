"use client";

import { UserButton } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { CATEGORIES, CONDITIONS, categoryLabel, type Category, type Condition } from "@/lib/categories";

type Tab = "browse" | "listings" | "requests" | "incoming" | "admin";

function errorMessage(e: unknown) {
  return e instanceof ConvexError ? String(e.data) : "Something went wrong. Please try again.";
}

export default function Dashboard() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const storeUser = useMutation(api.users.store);
  const [stored, setStored] = useState(false);
  const me = useQuery(api.users.me, stored ? {} : "skip");
  const [tab, setTab] = useState<Tab>("browse");

  // Create/refresh our user row once Convex has validated the Clerk token.
  useEffect(() => {
    if (!isAuthenticated) return;
    storeUser().then(() => setStored(true));
  }, [isAuthenticated, storeUser]);

  if (isLoading || !stored || !me) {
    return <p className="p-8 text-stone-500">Loading…</p>;
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "browse", label: "All tools" },
    { id: "listings", label: "My listings" },
    { id: "requests", label: "My requests" },
    { id: "incoming", label: "Incoming requests" },
    ...(me.role === "admin" ? [{ id: "admin" as Tab, label: "Admin" }] : []),
  ];

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-2xl font-bold">LendLoop</Link>
        <div className="flex items-center gap-3 text-sm text-stone-600">
          {me.trustedLender && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">Trusted Lender</span>}
          {me.role === "admin" && <span className="rounded-full bg-stone-200 px-2 py-0.5">admin</span>}
          <UserButton />
        </div>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === t.id ? "bg-stone-900 text-white" : "bg-white border border-stone-200"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "browse" && <Browse />}
      {tab === "listings" && <MyListings />}
      {tab === "requests" && <MyRequests />}
      {tab === "incoming" && <Incoming />}
      {tab === "admin" && me.role === "admin" && <Admin />}
    </main>
  );
}

const card = "rounded-lg border border-stone-200 bg-white p-4";
const input = "w-full rounded border border-stone-300 px-2 py-1.5 text-sm";
const btn = "rounded px-3 py-1.5 text-sm font-medium";

function AvailabilityBadge({ value }: { value: "available" | "on_loan" | "overdue" }) {
  const style = { available: "bg-emerald-100 text-emerald-800", on_loan: "bg-sky-100 text-sky-800", overdue: "bg-red-100 text-red-800" }[value];
  const label = { available: "Available", on_loan: "On loan", overdue: "Overdue" }[value];
  return <span className={`rounded-full px-2 py-0.5 text-xs ${style}`}>{label}</span>;
}

function Browse() {
  const [category, setCategory] = useState<Category | "">("");
  const tools = useQuery(api.tools.list, category ? { category } : {});
  return (
    <section>
      <select className={`${input} mb-4 max-w-xs`} value={category} onChange={(e) => setCategory(e.target.value as Category | "")}>
        <option value="">All categories</option>
        {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
      {tools === undefined ? <p>Loading…</p> : tools.length === 0 ? <p className="text-stone-500">No tools here yet.</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {tools.map((t) => (
            <div key={t._id} className={card}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{t.name}</h3>
                  <p className="text-xs text-stone-500">{categoryLabel(t.category)} · {t.condition} · by {t.ownerName}{t.ownerTrusted && " ★ Trusted"}</p>
                </div>
                <AvailabilityBadge value={t.availability} />
              </div>
              <p className="mt-2 text-sm text-stone-700">{t.description}</p>
              {!t.isMine && <BorrowForm toolId={t._id} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BorrowForm({ toolId }: { toolId: Id<"tools"> }) {
  const request = useMutation(api.loans.request);
  const [open, setOpen] = useState(false);
  const [startDate, setStart] = useState("");
  const [endDate, setEnd] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!open) return <button className={`${btn} mt-3 bg-emerald-700 text-white`} onClick={() => setOpen(true)}>Request to borrow</button>;
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await request({ toolId, startDate, endDate });
          setMsg("Request sent.");
          setOpen(false);
        } catch (err) {
          setMsg(errorMessage(err));
        }
      }}
    >
      <label className="text-xs">From<input type="date" required className={input} value={startDate} onChange={(e) => setStart(e.target.value)} /></label>
      <label className="text-xs">To<input type="date" required className={input} value={endDate} onChange={(e) => setEnd(e.target.value)} /></label>
      <button className={`${btn} bg-emerald-700 text-white`}>Send</button>
      <button type="button" className={`${btn} border`} onClick={() => setOpen(false)}>Cancel</button>
      {msg && <p className="w-full text-sm text-stone-600">{msg}</p>}
    </form>
  );
}

type ToolForm = { name: string; category: Category; condition: Condition; description: string };
const emptyForm: ToolForm = { name: "", category: "power_tools", condition: "good", description: "" };

function ToolEditor({ initial, onSave, onCancel }: { initial: ToolForm; onSave: (f: ToolForm) => Promise<void>; onCancel?: () => void }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className={`${card} grid gap-2`}
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSave(f);
          setErr(null);
        } catch (ex) {
          setErr(errorMessage(ex));
        }
      }}
    >
      <input className={input} placeholder="Tool name" maxLength={80} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <div className="flex gap-2">
        <select className={input} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Category })}>
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select className={input} value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value as Condition })}>
          {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <textarea className={input} placeholder="Short description" maxLength={500} required rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <div className="flex gap-2">
        <button className={`${btn} bg-emerald-700 text-white`}>Save</button>
        {onCancel && <button type="button" className={`${btn} border`} onClick={onCancel}>Cancel</button>}
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </form>
  );
}

function MyListings() {
  const tools = useQuery(api.tools.myListings);
  const create = useMutation(api.tools.create);
  const update = useMutation(api.tools.update);
  const remove = useMutation(api.tools.remove);
  const [editing, setEditing] = useState<Id<"tools"> | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="grid gap-4">
      <div>
        <h2 className="mb-2 font-semibold">List a tool</h2>
        <ToolEditor key={formKey} initial={emptyForm} onSave={async (f) => { await create(f); setFormKey((k) => k + 1); }} />
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}
      {tools?.map((t) =>
        editing === t._id ? (
          <ToolEditor
            key={t._id}
            initial={{ name: t.name, category: t.category, condition: t.condition, description: t.description }}
            onSave={async (f) => { await update({ toolId: t._id, ...f }); setEditing(null); }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={t._id} className={`${card} flex items-start justify-between`}>
            <div>
              <h3 className="font-semibold">{t.name} <AvailabilityBadge value={t.availability} /></h3>
              <p className="text-xs text-stone-500">{categoryLabel(t.category)} · {t.condition}</p>
              <p className="mt-1 text-sm">{t.description}</p>
            </div>
            <div className="flex gap-2">
              <button className={`${btn} border`} onClick={() => setEditing(t._id)}>Edit</button>
              <button
                className={`${btn} border border-red-300 text-red-700`}
                onClick={async () => { try { await remove({ toolId: t._id }); setErr(null); } catch (e) { setErr(errorMessage(e)); } }}
              >
                Delete
              </button>
            </div>
          </div>
        ),
      )}
    </section>
  );
}

type LoanView = {
  _id: Id<"loans">;
  toolName: string;
  lenderName: string;
  borrowerName: string;
  startDate: string;
  endDate: string;
  status: "requested" | "approved" | "declined" | "returned";
  overdue: boolean;
  lastAutomation: { kind: string; status: string; at: number } | null;
};

function timeAgo(ms: number) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days >= 1) return `${days} day${days > 1 ? "s" : ""} ago`;
  const hours = Math.floor((Date.now() - ms) / 3_600_000);
  return hours >= 1 ? `${hours}h ago` : "just now";
}

function LoanRow({ loan, actions }: { loan: LoanView; actions?: React.ReactNode }) {
  const auto = loan.lastAutomation;
  return (
    <div className={`${card} flex items-start justify-between gap-3`}>
      <div>
        <h3 className="font-semibold">{loan.toolName}</h3>
        <p className="text-xs text-stone-500">
          {loan.borrowerName} borrows from {loan.lenderName} · {loan.startDate} → {loan.endDate}
        </p>
        <p className="mt-1 text-sm">
          <span className="font-medium capitalize">{loan.status}</span>
          {loan.overdue && <span className="ml-2 text-red-700">overdue</span>}
        </p>
        {auto && (
          <p className="mt-1 text-xs text-stone-500">
            {auto.kind === "overdue_reminder" ? "Reminder" : "Notification"} {auto.status === "sent" ? "sent" : "failed"} {timeAgo(auto.at)}
          </p>
        )}
      </div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

function MyRequests() {
  const loans = useQuery(api.loans.myRequests);
  if (loans === undefined) return <p>Loading…</p>;
  if (loans.length === 0) return <p className="text-stone-500">You haven&apos;t requested anything yet.</p>;
  return <section className="grid gap-3">{loans.map((l) => <LoanRow key={l._id} loan={l} />)}</section>;
}

function Incoming() {
  const loans = useQuery(api.loans.incoming);
  const respond = useMutation(api.loans.respond);
  const markReturned = useMutation(api.loans.markReturned);
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setErr(null)).catch((e) => setErr(errorMessage(e)));
  if (loans === undefined) return <p>Loading…</p>;
  if (loans.length === 0) return <p className="text-stone-500">No requests for your tools yet.</p>;
  return (
    <section className="grid gap-3">
      {err && <p className="text-sm text-red-700">{err}</p>}
      {loans.map((l) => (
        <LoanRow
          key={l._id}
          loan={l}
          actions={
            l.status === "requested" ? (
              <>
                <button className={`${btn} bg-emerald-700 text-white`} onClick={() => run(respond({ loanId: l._id, approve: true }))}>Approve</button>
                <button className={`${btn} border`} onClick={() => run(respond({ loanId: l._id, approve: false }))}>Decline</button>
              </>
            ) : l.status === "approved" ? (
              <button className={`${btn} border`} onClick={() => run(markReturned({ loanId: l._id }))}>Mark returned</button>
            ) : null
          }
        />
      ))}
    </section>
  );
}

function Admin() {
  const tools = useQuery(api.tools.adminAll);
  const loans = useQuery(api.loans.adminAll);
  const remove = useMutation(api.tools.remove);
  const setTrusted = useMutation(api.users.setTrustedLender);
  return (
    <section className="grid gap-6">
      <div>
        <h2 className="mb-2 font-semibold">All listings</h2>
        <div className="grid gap-2">
          {tools?.map((t) => (
            <div key={t._id} className={`${card} flex items-center justify-between`}>
              <span>{t.name} <span className="text-xs text-stone-500">by {t.ownerName}{t.ownerTrusted && " ★"}</span></span>
              <div className="flex gap-2">
                <button className={`${btn} border`} onClick={() => setTrusted({ userId: t.ownerId, trusted: !t.ownerTrusted })}>
                  {t.ownerTrusted ? "Remove Trusted" : "Mark Trusted Lender"}
                </button>
                <button className={`${btn} border border-red-300 text-red-700`} onClick={() => remove({ toolId: t._id })}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h2 className="mb-2 font-semibold">All loans</h2>
        <div className="grid gap-2">{loans?.map((l) => <LoanRow key={l._id} loan={l} />)}</div>
      </div>
    </section>
  );
}
