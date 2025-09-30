class OrderShippedJob < ApplicationJob
  queue_as :default

  def perform(payload, company_id)
    sync_shipped_order_service = Shipstation::SyncShippedOrder.new(payload, company_id)
    sync_shipped_order_service.call
  rescue StandardError => e
    Rails.logger.error("Error syncing order: #{e.message} - OrderShippedJob")
  end
end
