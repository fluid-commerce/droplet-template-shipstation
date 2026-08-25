/**
 * Port of app/models/shipstation_order.rb's status vocabulary, plus the JSON
 * shape OrdersController rendered for the Activity tab.
 */

import type { ShipstationOrder } from "@prisma/client";

export const STATUSES = [
  "PENDING",
  "SUBMITTED",
  "SHIPPED",
  "FAILED",
  "AWAITING_PAYMENT",
  "HELD",
  "CANCELLED",
] as const;

/** Statuses from which an order may still be sent to ShipStation at all. */
export const SENDABLE_STATUSES = ["FAILED", "AWAITING_PAYMENT", "PENDING", "HELD"];

/**
 * Statuses an admin can manually resend from the Activity tab.
 *
 * Excludes AWAITING_PAYMENT (`respectHold: false` doesn't bypass the payment
 * gate, so a resend would silently re-hold) and terminal
 * CANCELLED/SUBMITTED/SHIPPED.
 */
export const RESENDABLE_STATUSES = ["FAILED", "PENDING", "HELD"];

export const isSendable = (status: string) => SENDABLE_STATUSES.includes(status);
export const isResendable = (status: string) => RESENDABLE_STATUSES.includes(status);

export function orderJson(order: ShipstationOrder) {
  return {
    id: Number(order.id),
    fluid_order_number: order.fluidOrderNumber,
    status: order.status,
    shipstation_order_id: order.shipstationOrderId,
    tracking_numbers: order.trackingNumbers,
    carrier: order.carrier,
    last_error: order.lastError,
    hold_until: order.holdUntil,
    resendable: isResendable(order.status),
    created_at: order.createdAt,
  };
}
