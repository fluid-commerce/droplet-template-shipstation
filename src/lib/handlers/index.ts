/**
 * Event handler registration.
 *
 * Mirrors config/initializers/event_handler.rb.
 */

import { registerHandler } from "@/lib/events";
import { handleDropletInstalled } from "./droplet-installed";
import { handleDropletUninstalled } from "./droplet-uninstalled";
import {
  handleOrderCreated,
  handleOrderShipped,
  handleOrderUpdated,
} from "./order-events";

let initialized = false;

export function initializeHandlers(): void {
  if (initialized) return;
  initialized = true;

  registerHandler("droplet.installed", handleDropletInstalled);
  registerHandler("droplet.uninstalled", handleDropletUninstalled);

  // order.created feeds new orders in; order.updated releases orders that were
  // held (AWAITING_PAYMENT) once they become fulfillable.
  registerHandler("order.created", handleOrderCreated);
  registerHandler("order.updated", handleOrderUpdated);

  // Cancel/refund flow through the same status-gated path as order.updated:
  // createShipstationOrder only recalls the ShipStation order when the status is
  // actually unfulfillable, so a partial refund that still ships is left alone.
  // (Primary coverage is order.updated, which fires on the status change
  // regardless.)
  registerHandler("order.cancelled", handleOrderUpdated);
  registerHandler("order.refunded", handleOrderUpdated);

  registerHandler("order.shipped", handleOrderShipped);
}

export { handleDropletInstalled } from "./droplet-installed";
export { handleDropletUninstalled } from "./droplet-uninstalled";
export { handleDropletReinstalled } from "./droplet-reinstalled";
export { findCompanyForPayload } from "./find-company";
export {
  handleOrderCreated,
  handleOrderShipped,
  handleOrderUpdated,
} from "./order-events";
