# frozen_string_literal: true

class OrderCreatedJob < WebhookEventJob
  def process_webhook
    create_order_service = Shipstation::CreateOrder.new(get_payload)
    create_order_service.call
  end
end
