# frozen_string_literal: true

# Handles the Fluid order.updated webhook. Delegates to Shipstation::CreateOrder,
# whose status gating decides what to do: release a held AWAITING_PAYMENT order
# once it becomes fulfillable, skip orders already in ShipStation (idempotent),
# or create an order that was never seen via order.created.
class OrderUpdatedJob < WebhookEventJob
  def process_webhook
    Shipstation::CreateOrder.new(get_payload).call
  end
end
