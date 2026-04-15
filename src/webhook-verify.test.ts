import { describe, it, expect } from "vitest";
import { Webhook } from "svix";
import { verifyBluedotWebhook, WebhookVerificationError } from "./webhook-verify";

const TEST_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function signPayload(body: string, secret: string, svixId: string, timestamp: number) {
  const wh = new Webhook(secret);
  const toSign = `${svixId}.${timestamp}.${body}`;
  const secretBytes = Uint8Array.from(
    atob(secret.replace(/^whsec_/, "")),
    (c) => c.charCodeAt(0),
  );
  const encoder = new TextEncoder();
  return crypto.subtle
    .importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((key) => crypto.subtle.sign("HMAC", key, encoder.encode(toSign)))
    .then((sig) => {
      const bytes = new Uint8Array(sig);
      const b64 = btoa(String.fromCharCode(...bytes));
      return `v1,${b64}`;
    });
}

function makeHeaders(svixId: string, timestamp: number, signature: string): Headers {
  return new Headers({
    "svix-id": svixId,
    "svix-timestamp": String(timestamp),
    "svix-signature": signature,
  });
}

describe("verifyBluedotWebhook", () => {
  const body = JSON.stringify({ id: "msg_test", text: "hello world" });
  const svixId = "msg_2abcdef";

  it("returns parsed payload for valid signature", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signPayload(body, TEST_SECRET, svixId, timestamp);
    const headers = makeHeaders(svixId, timestamp, signature);

    const result = verifyBluedotWebhook(body, headers, TEST_SECRET);

    expect(result).toEqual({ id: "msg_test", text: "hello world" });
  });

  it("throws on invalid signature", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = makeHeaders(svixId, timestamp, "v1,invalidbase64signature");

    expect(() => verifyBluedotWebhook(body, headers, TEST_SECRET)).toThrow(
      WebhookVerificationError,
    );
  });

  it("throws on missing svix-id header", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signPayload(body, TEST_SECRET, svixId, timestamp);
    const headers = new Headers({
      "svix-timestamp": String(timestamp),
      "svix-signature": signature,
    });

    expect(() => verifyBluedotWebhook(body, headers, TEST_SECRET)).toThrow(
      WebhookVerificationError,
    );
  });

  it("throws on stale timestamp (replay attack)", async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 60 * 60; // 1h ago
    const signature = await signPayload(body, TEST_SECRET, svixId, oldTimestamp);
    const headers = makeHeaders(svixId, oldTimestamp, signature);

    expect(() => verifyBluedotWebhook(body, headers, TEST_SECRET)).toThrow(
      WebhookVerificationError,
    );
  });

  it("throws on tampered body", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signPayload(body, TEST_SECRET, svixId, timestamp);
    const headers = makeHeaders(svixId, timestamp, signature);
    const tampered = body.replace("hello world", "evil payload");

    expect(() => verifyBluedotWebhook(tampered, headers, TEST_SECRET)).toThrow(
      WebhookVerificationError,
    );
  });
});
