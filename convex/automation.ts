import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { todayUTC } from "./lib/dates";
import { signBody } from "./lib/signing";
import { loanStatus } from "./schema";

const MAX_ATTEMPTS = 5;

type LoanEventPayload = {
  event: string;
  loanId: string;
  toolName: string;
  startDate: string;
  endDate: string;
  recipient: { name: string; email: string | null };
};
const kind = v.union(v.literal("request_notification"), v.literal("overdue_reminder"));
const eventStatus = v.union(v.literal("sent"), v.literal("failed"));

/**
 * Minimal payload for a loan notification: only what the recipient needs to read
 * the message. No ids of other users, no descriptions, no condition, no owner email
 * unless the owner is the one being notified.
 */
export const loanEventPayload = internalQuery({
  args: { loanId: v.id("loans"), status: loanStatus },
  handler: async (ctx, { loanId, status }) => {
    const loan = await ctx.db.get(loanId);
    if (!loan) return null;
    const tool = await ctx.db.get(loan.toolId);
    // New requests go to the lender; every later change goes to the borrower.
    const recipientId = status === "requested" ? loan.lenderId : loan.borrowerId;
    const recipient = await ctx.db.get(recipientId);
    if (!recipient) return null;
    return {
      event: `loan.${status}`,
      loanId,
      toolName: tool?.name ?? "a tool",
      startDate: loan.startDate,
      endDate: loan.endDate,
      recipient: { name: recipient.name, email: recipient.email ?? null },
    };
  },
});

/** Claims an event key. Returns false when the event was already sent (retry or duplicate). */
export const claimEvent = internalMutation({
  args: { key: v.string(), loanId: v.id("loans"), kind },
  handler: async (ctx, { key, loanId, kind }) => {
    const existing = await ctx.db.query("automationEvents").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (existing?.status === "sent") return { proceed: false, attempts: existing.attempts };
    if (existing) {
      await ctx.db.patch(existing._id, { attempts: existing.attempts + 1, updatedAt: Date.now() });
      return { proceed: true, attempts: existing.attempts + 1 };
    }
    await ctx.db.insert("automationEvents", {
      key,
      loanId,
      kind,
      status: "pending",
      attempts: 1,
      updatedAt: Date.now(),
    });
    return { proceed: true, attempts: 1 };
  },
});

/**
 * Idempotent upsert keyed by `key`. Used by our own sender and by n8n write-backs,
 * so a retried n8n run updates the same row instead of creating a duplicate.
 * A row already marked "sent" never goes back to "failed".
 */
export const recordEvent = internalMutation({
  args: {
    key: v.string(),
    loanId: v.id("loans"),
    kind,
    status: eventStatus,
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const detail = args.detail?.slice(0, 300);
    const existing = await ctx.db.query("automationEvents").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    if (existing) {
      if (existing.status === "sent") return existing._id;
      await ctx.db.patch(existing._id, { status: args.status, detail, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("automationEvents", {
      key: args.key,
      loanId: args.loanId,
      kind: args.kind,
      status: args.status,
      attempts: 1,
      detail,
      updatedAt: Date.now(),
    });
  },
});

/** Convex -> n8n: signed webhook for request created / status changed. Retries with backoff. */
export const sendLoanEvent = internalAction({
  args: { loanId: v.id("loans"), status: loanStatus, eventKey: v.string() },
  handler: async (ctx, { loanId, status, eventKey }): Promise<void> => {
    const claim: { proceed: boolean; attempts: number } = await ctx.runMutation(internal.automation.claimEvent, {
      key: eventKey,
      loanId,
      kind: "request_notification",
    });
    if (!claim.proceed) return;

    const fail = async (detail: string) => {
      if (claim.attempts < MAX_ATTEMPTS) {
        // 30s, 60s, 120s, 240s
        await ctx.scheduler.runAfter(30_000 * 2 ** (claim.attempts - 1), internal.automation.sendLoanEvent, {
          loanId,
          status,
          eventKey,
        });
      } else {
        await ctx.runMutation(internal.automation.recordEvent, {
          key: eventKey,
          loanId,
          kind: "request_notification",
          status: "failed",
          detail,
        });
      }
    };

    const url = process.env.N8N_REQUEST_WEBHOOK_URL;
    const secret = process.env.N8N_OUTBOUND_SECRET;
    if (!url || !secret) {
      await ctx.runMutation(internal.automation.recordEvent, {
        key: eventKey,
        loanId,
        kind: "request_notification",
        status: "failed",
        detail: "n8n webhook not configured",
      });
      return;
    }

    const payload: LoanEventPayload | null = await ctx.runQuery(internal.automation.loanEventPayload, { loanId, status });
    if (!payload) return;
    const body: string = JSON.stringify({ ...payload, eventKey });
    const { timestamp, signature } = await signBody(secret, body);

    try {
      const res: Response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LendLoop-Timestamp": timestamp,
          "X-LendLoop-Signature": signature,
          // n8n can use this to dedupe on its side as well.
          "Idempotency-Key": eventKey,
        },
        body,
      });
      if (!res.ok) return await fail(`n8n responded ${res.status}`);
      await ctx.runMutation(internal.automation.recordEvent, {
        key: eventKey,
        loanId,
        kind: "request_notification",
        status: "sent",
      });
    } catch (e) {
      await fail(e instanceof Error ? e.message : "network error");
    }
  },
});

/** For n8n's daily run: approved loans past their end date with no reminder sent today. */
export const overdueForReminder = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = todayUTC();
    const overdue = await ctx.db
      .query("loans")
      .withIndex("by_status_endDate", (q) => q.eq("status", "approved").lt("endDate", today))
      .collect();
    const out = [];
    for (const loan of overdue) {
      const reminderKey = `overdue:${loan._id}:${today}`;
      const already = await ctx.db.query("automationEvents").withIndex("by_key", (q) => q.eq("key", reminderKey)).unique();
      if (already?.status === "sent") continue;
      const [tool, borrower] = await Promise.all([ctx.db.get(loan.toolId), ctx.db.get(loan.borrowerId)]);
      if (!borrower) continue;
      out.push({
        loanId: loan._id,
        reminderKey,
        toolName: tool?.name ?? "a tool",
        endDate: loan.endDate,
        borrower: { name: borrower.name, email: borrower.email ?? null },
      });
    }
    return out;
  },
});
