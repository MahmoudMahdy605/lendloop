import { internalMutation } from "./_generated/server";

/**
 * Local demo data, run from the CLI only: `npx convex run seed:demo`.
 * Creates two neighbors, a few tools and one overdue loan so the n8n
 * reminder workflow has something to do. Internal: not callable from the browser.
 */
export const demo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const alice = await ctx.db.insert("users", {
      tokenIdentifier: "seed|alice",
      name: "Alice (demo)",
      email: "alice@example.com",
      role: "user",
      trustedLender: true,
    });
    const bob = await ctx.db.insert("users", {
      tokenIdentifier: "seed|bob",
      name: "Bob (demo)",
      email: "bob@example.com",
      role: "user",
      trustedLender: false,
    });
    const drill = await ctx.db.insert("tools", {
      ownerId: alice,
      name: "Cordless drill",
      category: "power_tools",
      condition: "good",
      description: "18V with two batteries and a bit set.",
    });
    await ctx.db.insert("tools", {
      ownerId: alice,
      name: "Camping stove",
      category: "camping",
      condition: "fair",
      description: "Two-burner gas stove. Bring your own gas.",
    });
    await ctx.db.insert("tools", {
      ownerId: bob,
      name: "Hedge trimmer",
      category: "garden",
      condition: "new",
      description: "Electric, 50 cm blade.",
    });
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const loanId = await ctx.db.insert("loans", {
      toolId: drill,
      lenderId: alice,
      borrowerId: bob,
      startDate: day(-7),
      endDate: day(-2),
      status: "approved",
      updatedAt: Date.now(),
    });
    return { alice, bob, drill, overdueLoan: loanId };
  },
});
