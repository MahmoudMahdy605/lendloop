import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { signBody, verifySignature } from "../convex/lib/signing";
import { isValidDate, overlaps } from "../convex/lib/dates";

const SECRET = "test-secret";

describe("HMAC signing", () => {
  it("round-trips a signed body", async () => {
    const body = JSON.stringify({ event: "loan.approved" });
    const { timestamp, signature } = await signBody(SECRET, body);
    expect(await verifySignature(SECRET, body, timestamp, signature)).toBe(true);
  });

  it("matches the Node crypto implementation used in the n8n Code nodes", async () => {
    const body = '{"a":1}';
    const { timestamp, signature } = await signBody(SECRET, body);
    const nodeSig = "sha256=" + createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
    expect(signature).toBe(nodeSig);
  });

  it("rejects a tampered body, a wrong secret and a missing header", async () => {
    const { timestamp, signature } = await signBody(SECRET, '{"a":1}');
    expect(await verifySignature(SECRET, '{"a":2}', timestamp, signature)).toBe(false);
    expect(await verifySignature("other", '{"a":1}', timestamp, signature)).toBe(false);
    expect(await verifySignature(SECRET, '{"a":1}', null, signature)).toBe(false);
    expect(await verifySignature(undefined, '{"a":1}', timestamp, signature)).toBe(false);
  });

  it("rejects replays older than 5 minutes", async () => {
    const tenMinAgo = Date.now() - 10 * 60_000;
    const { timestamp, signature } = await signBody(SECRET, "{}", tenMinAgo);
    expect(await verifySignature(SECRET, "{}", timestamp, signature)).toBe(false);
  });
});

describe("dates", () => {
  it("validates real calendar dates only", () => {
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("26-1-1")).toBe(false);
  });

  it("detects inclusive overlaps", () => {
    expect(overlaps("2026-01-01", "2026-01-05", "2026-01-05", "2026-01-07")).toBe(true);
    expect(overlaps("2026-01-01", "2026-01-04", "2026-01-05", "2026-01-07")).toBe(false);
  });
});
