// HMAC-SHA256 request signing shared by both directions of the n8n integration.
// Signature = hex(HMAC(secret, `${timestamp}.${rawBody}`)), sent in headers:
//   X-LendLoop-Timestamp: unix seconds
//   X-LendLoop-Signature: sha256=<hex>
// Including the timestamp blocks replays of old payloads (5-minute window).

export const MAX_SKEW_SECONDS = 300;

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signBody(secret: string, body: string, now = Date.now()) {
  const timestamp = Math.floor(now / 1000).toString();
  const signature = await hmacHex(secret, `${timestamp}.${body}`);
  return { timestamp, signature: `sha256=${signature}` };
}

export async function verifySignature(
  secret: string | undefined,
  body: string,
  timestamp: string | null,
  signature: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  const expected = `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`;
  return timingSafeEqual(expected, signature);
}
