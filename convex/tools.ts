import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { getCurrentUser, requireUser } from "./lib/auth";
import { todayUTC } from "./lib/dates";
import { categories, conditions } from "./schema";

const MAX = { name: 80, description: 500 };

function cleanText(value: string, field: keyof typeof MAX): string {
  const s = value.trim();
  if (!s) throw new ConvexError(`${field} is required`);
  if (s.length > MAX[field]) throw new ConvexError(`${field} is too long (max ${MAX[field]})`);
  return s;
}

async function availability(ctx: QueryCtx, toolId: Id<"tools">) {
  const today = todayUTC();
  const loans = await ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId))
    .collect();
  const current = loans.find(
    (l) => l.status === "approved" && l.startDate <= today && today <= l.endDate,
  );
  const overdue = loans.find((l) => l.status === "approved" && l.endDate < today);
  return current ? ("on_loan" as const) : overdue ? ("overdue" as const) : ("available" as const);
}

/** Public landing page: name and category only. No owner, no condition, no ids beyond the doc id. */
export const listPublic = query({
  args: {},
  handler: async (ctx) => {
    const tools = await ctx.db.query("tools").order("desc").take(100);
    return tools.map((t) => ({ _id: t._id, name: t.name, category: t.category }));
  },
});

/** Signed-in browse view with availability and owner display name. */
export const list = query({
  args: { category: v.optional(categories) },
  handler: async (ctx, { category }) => {
    const me = await getCurrentUser(ctx);
    if (!me) return [];
    const tools = category
      ? await ctx.db.query("tools").withIndex("by_category", (q) => q.eq("category", category)).collect()
      : await ctx.db.query("tools").order("desc").collect();
    return await Promise.all(tools.map(async (t) => toView(ctx, t, me._id)));
  },
});

export const myListings = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUser(ctx);
    if (!me) return [];
    const tools = await ctx.db.query("tools").withIndex("by_owner", (q) => q.eq("ownerId", me._id)).collect();
    return await Promise.all(tools.map(async (t) => toView(ctx, t, me._id)));
  },
});

async function toView(ctx: QueryCtx, t: Doc<"tools">, meId: Id<"users">) {
  const owner = await ctx.db.get(t.ownerId);
  return {
    _id: t._id,
    name: t.name,
    category: t.category,
    condition: t.condition,
    description: t.description,
    ownerName: owner?.name ?? "Unknown",
    ownerTrusted: owner?.trustedLender ?? false,
    isMine: t.ownerId === meId,
    availability: await availability(ctx, t._id),
  };
}

/** Admin view: every listing with its owner, so admins can remove listings and mark trusted lenders. */
export const adminAll = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUser(ctx);
    if (!me || me.role !== "admin") return [];
    const tools = await ctx.db.query("tools").order("desc").collect();
    return await Promise.all(
      tools.map(async (t) => ({ ...(await toView(ctx, t, me._id)), ownerId: t.ownerId })),
    );
  },
});

export const create = mutation({
  args: { name: v.string(), category: categories, condition: conditions, description: v.string() },
  handler: async (ctx, args) => {
    const me = await requireUser(ctx);
    return await ctx.db.insert("tools", {
      ownerId: me._id,
      name: cleanText(args.name, "name"),
      category: args.category,
      condition: args.condition,
      description: cleanText(args.description, "description"),
    });
  },
});

export const update = mutation({
  args: {
    toolId: v.id("tools"),
    name: v.string(),
    category: categories,
    condition: conditions,
    description: v.string(),
  },
  handler: async (ctx, { toolId, ...args }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.ownerId !== me._id) throw new ConvexError("You can only edit your own listings");
    await ctx.db.patch(toolId, {
      name: cleanText(args.name, "name"),
      category: args.category,
      condition: args.condition,
      description: cleanText(args.description, "description"),
    });
  },
});

/** Owners delete their own listing; admins can remove any listing. */
export const remove = mutation({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool) return;
    const isOwner = tool.ownerId === me._id;
    if (!isOwner && me.role !== "admin") throw new ConvexError("Not allowed");

    const loans = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", toolId)).collect();
    if (isOwner && me.role !== "admin" && loans.some((l) => l.status === "approved")) {
      throw new ConvexError("This tool is out on loan. Mark it returned before deleting.");
    }
    // Close open requests so borrowers aren't left waiting on a tool that no longer exists.
    for (const l of loans) {
      if (l.status === "requested" || l.status === "approved") {
        await ctx.db.patch(l._id, { status: "declined", updatedAt: Date.now() });
      }
    }
    await ctx.db.delete(toolId);
  },
});
