import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { verifySignature } from "./lib/signing";

const http = httpRouter();

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Reads the raw body and checks the n8n -> Convex signature before anything else. */
async function verified(req: Request): Promise<string | null> {
  const body = await req.text();
  const ok = await verifySignature(
    process.env.N8N_INBOUND_SECRET,
    body,
    req.headers.get("X-LendLoop-Timestamp"),
    req.headers.get("X-LendLoop-Signature"),
  );
  return ok ? body : null;
}

// n8n daily schedule -> fetch overdue loans that still need a reminder today.
http.route({
  path: "/n8n/overdue-loans",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if ((await verified(req)) === null) return json(401, { error: "bad signature" });
    const loans = await ctx.runQuery(internal.automation.overdueForReminder, {});
    return json(200, { loans });
  }),
});

// n8n -> write back the result of a reminder (or a failure from the error workflow).
// Idempotent: the same key always updates the same row.
http.route({
  path: "/n8n/automation-status",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await verified(req);
    if (body === null) return json(401, { error: "bad signature" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { error: "invalid json" });
    }
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.key !== "string" ||
      typeof p.loanId !== "string" ||
      (p.kind !== "request_notification" && p.kind !== "overdue_reminder") ||
      (p.status !== "sent" && p.status !== "failed") ||
      (p.detail !== undefined && typeof p.detail !== "string")
    ) {
      return json(400, { error: "invalid body" });
    }
    try {
      await ctx.runMutation(internal.automation.recordEvent, {
        key: p.key,
        loanId: p.loanId as Id<"loans">,
        kind: p.kind,
        status: p.status,
        detail: p.detail as string | undefined,
      });
    } catch {
      return json(400, { error: "unknown loan" });
    }
    return json(200, { ok: true });
  }),
});

export default http;
