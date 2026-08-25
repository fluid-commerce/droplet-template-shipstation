/**
 * Which statuses may be resent.
 *
 * This is the list the Activity tab's "Send now" button is gated on, and the
 * server re-checks it — so a stale page cannot resend an order that has since
 * been submitted, shipped, or cancelled.
 */

import { describe, it, expect } from "vitest";

import { isResendable, isSendable, RESENDABLE_STATUSES, STATUSES } from "./orders";

describe("isResendable", () => {
  it("allows exactly FAILED, PENDING and HELD", () => {
    expect(STATUSES.filter(isResendable)).toEqual(["PENDING", "FAILED", "HELD"]);
  });

  it("excludes AWAITING_PAYMENT, which would silently re-hold", () => {
    expect(isResendable("AWAITING_PAYMENT")).toBe(false);
    // …even though it is otherwise sendable by the batch release path.
    expect(isSendable("AWAITING_PAYMENT")).toBe(true);
  });

  it("excludes everything terminal, so a labeled order is never re-sent", () => {
    expect(isResendable("SUBMITTED")).toBe(false);
    expect(isResendable("SHIPPED")).toBe(false);
    expect(isResendable("CANCELLED")).toBe(false);
  });

  it("keeps the list in sync with the exported constant", () => {
    expect(new Set(STATUSES.filter(isResendable))).toEqual(
      new Set(RESENDABLE_STATUSES),
    );
  });
});
