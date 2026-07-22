# frozen_string_literal: true

# Register default webhook event handlers.
#
# This is inside a to_prepare block which runs after all application code
# is loaded, making sure the constants are defined when this runs.
# It also runs on every code reload in development, ensuring the handlers
# are always registered.
Rails.application.config.to_prepare do
  # EventHandler.register_handler("company_droplet.created", DropletInstalledJob)
  EventHandler.register_handler("droplet.uninstalled", DropletUninstalledJob)
  EventHandler.register_handler("droplet.installed", DropletInstalledJob)
  EventHandler.register_handler("order.created", OrderCreatedJob)
  EventHandler.register_handler("order.updated", OrderUpdatedJob)
  # Cancel/refund flow through the same status-gated path as order.updated:
  # CreateOrder only recalls the ShipStation order when the status is actually
  # unfulfillable, so a partial refund that still ships is left alone. (Primary
  # coverage is order.updated, which fires on the status change regardless.)
  EventHandler.register_handler("order.cancelled", OrderUpdatedJob)
  EventHandler.register_handler("order.refunded", OrderUpdatedJob)
  EventHandler.register_handler("order.shipped", OrderShippedJob)
end
