import { Webhook, WebhookVerificationError as SvixVerificationError } from "svix";

export class WebhookVerificationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Verify a Bluedot webhook using Svix's HMAC-SHA256 scheme.
 *
 * Throws {@link WebhookVerificationError} on:
 * - missing/invalid svix headers
 * - signature mismatch
 * - stale timestamp (replay protection, Svix default tolerance = 5 minutes)
 */
export function verifyBluedotWebhook<T = unknown>(
  body: string,
  headers: Headers,
  secret: string,
): T {
  const svixId = headers.get("svix-id");
  const svixTimestamp = headers.get("svix-timestamp");
  const svixSignature = headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new WebhookVerificationError(
      "Missing one or more required Svix headers (svix-id, svix-timestamp, svix-signature)",
    );
  }

  const wh = new Webhook(secret);

  try {
    return wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as T;
  } catch (err) {
    if (err instanceof SvixVerificationError) {
      throw new WebhookVerificationError(err.message, err);
    }
    throw new WebhookVerificationError(
      err instanceof Error ? err.message : "Unknown verification error",
      err,
    );
  }
}
