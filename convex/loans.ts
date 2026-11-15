import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { getCurrentUser, requireAdmin, requireUser } from "./lib/auth";
import { isValidDate, overlaps, todayUTC } from "./lib/dates";

const MAX_LOAN_DAYS = 30;

async function assertNoOverlap(
  ctx: MutationCtx,
  toolId: Id<"tools">,
  startDate: string,
  endDate: string,
  ignoreLoanId?: Id<"loans">,
) {
  const loans = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", toolId)).collect();
  const clash = loans.find(
    (l) => l._id !== ignoreLoanId && l.status === "approved" && overlaps(l.startDate, l.endDate, startDate, endDate),
  );
  if (clash) throw new ConvexError("The tool is already lent out for part of those dates");
}

/** Status change + outgoing notification are scheduled in the same transaction: no lost events. */
async function setStatus(ctx: MutationCtx, loan: Doc<"loans">, status: Doc<"loans">["status"]) {
  const updatedAt = Date.now();
  await ctx.db.patch(loan._id, { status, updatedAt });
  await ctx.scheduler.runAfter(0, internal.automation.sendLoanEvent, {
    loanId: loan._id,
    status,
    eventKey: `notify:${loan._id}:${status}:${updatedAt}`,
  });
}

export const request = mutation({
  args: { toolId: v.id("tools"), startDate: v.string(), endDate: v.string() },
  handler: async (ctx, { toolId, startDate, endDate }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool) throw new ConvexError("Tool not found");
    if (tool.ownerId === me._id) throw new ConvexError("You can't borrow your own tool");
    if (!isValidDate(startDate) || !isValidDate(endDate)) throw new ConvexError("Invalid dates");
    if (startDate < todayUTC()) throw new ConvexError("Start date can't be in the past");
    if (endDate < startDate) throw new ConvexError("End date must be on or after the start date");
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
    if (days > MAX_LOAN_DAYS) throw new ConvexError(`Loans are limited to ${MAX_LOAN_DAYS} days`);
    await assertNoOverlap(ctx, toolId, startDate, endDate);

    const mine = await ctx.db.query("loans").withIndex("by_borrower", (q) => q.eq("borrowerId", me._id)).collect();
    if (mine.some((l) => l.toolId === toolId && l.status === "requested")) {
      throw new ConvexError("You already have a pending request for this tool");
    }

    const updatedAt = Date.now();
    const loanId = await ctx.db.insert("loans", {
      toolId,
      lenderId: tool.ownerId,
      borrowerId: me._id,
      startDate,
      endDate,
      status: "requested",
      updatedAt,
    });
    await ctx.scheduler.runAfter(0, internal.automation.sendLoanEvent, {
      loanId,
      status: "requested",
      eventKey: `notify:${loanId}:requested:${updatedAt}`,
    });
    return loanId;
  },
});

/** Only the lender (tool owner) can approve or decline. */
export const respond = mutation({
  args: { loanId: v.id("loans"), approve: v.boolean() },
  handler: async (ctx, { loanId, approve }) => {
    const me = await requireUser(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || loan.lenderId !== me._id) throw new ConvexError("Not your request to answer");
    if (loan.status !== "requested") throw new ConvexError("This request was already answered");
    if (approve) await assertNoOverlap(ctx, loan.toolId, loan.startDate, loan.endDate, loan._id);
    await setStatus(ctx, loan, approve ? "approved" : "declined");
  },
});

/** The lender confirms the tool came back. */
export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || loan.lenderId !== me._id) throw new ConvexError("Only the lender can mark a loan returned");
    if (loan.status !== "approved") throw new ConvexError("Only approved loans can be returned");
    await setStatus(ctx, loan, "returned");
  },
});

async function toView(ctx: QueryCtx, l: Doc<"loans">) {
  const [tool, lender, borrower, events] = await Promise.all([
    ctx.db.get(l.toolId),
    ctx.db.get(l.lenderId),
    ctx.db.get(l.borrowerId),
    ctx.db.query("automationEvents").withIndex("by_loan", (q) => q.eq("loanId", l._id)).collect(),
  ]);
  const lastAutomation = events.filter((e) => e.status !== "pending").sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    _id: l._id,
    toolName: tool?.name ?? "Removed tool",
    lenderName: lender?.name ?? "Unknown",
    borrowerName: borrower?.name ?? "Unknown",
    startDate: l.startDate,
    endDate: l.endDate,
    status: l.status,
    overdue: l.status === "approved" && l.endDate < todayUTC(),
    lastAutomation: lastAutomation
      ? { kind: lastAutomation.kind, status: lastAutomation.status, at: lastAutomation.updatedAt }
      : null,
  };
}

export const myRequests = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUser(ctx);
    if (!me) return [];
    const loans = await ctx.db.query("loans").withIndex("by_borrower", (q) => q.eq("borrowerId", me._id)).order("desc").collect();
    return await Promise.all(loans.map((l) => toView(ctx, l)));
  },
});

export const incoming = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUser(ctx);
    if (!me) return [];
    const loans = await ctx.db.query("loans").withIndex("by_lender", (q) => q.eq("lenderId", me._id)).order("desc").collect();
    return await Promise.all(loans.map((l) => toView(ctx, l)));
  },
});

export const adminAll = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const loans = await ctx.db.query("loans").order("desc").take(200);
    return await Promise.all(
      loans.map(async (l) => ({ ...(await toView(ctx, l)), lenderId: l.lenderId })),
    );
  },
});
