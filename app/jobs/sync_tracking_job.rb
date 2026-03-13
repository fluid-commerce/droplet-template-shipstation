# frozen_string_literal: true

# Cron job to retry syncing tracking info to Fluid for orders that
# were shipped but failed to sync via the ShipStation webhook.
#
# Schedule via Solid Queue's recurring tasks or cron:
#   SyncTrackingJob.perform_later
class SyncTrackingJob < ApplicationJob
  queue_as :default

  retry_on StandardError, attempts: 3, wait: 30.seconds

  BATCH_SIZE = 100

  def perform
    orders = ShipstationOrder.needs_tracking_sync.limit(BATCH_SIZE).includes(:company)

    Rails.logger.info("[SyncTracking] Found #{orders.count} orders to sync")

    synced = 0
    failed = 0

    orders.find_each do |order|
      sync_order(order)
      synced += 1
    rescue StandardError => e
      Rails.logger.error("[SyncTracking] Failed to sync order #{order.fluid_order_number}: #{e.message}")
      failed += 1
    end

    Rails.logger.info("[SyncTracking] Completed: #{synced} synced, #{failed} failed")
  end

private

  def sync_order(order)
    integration_setting = IntegrationSetting.find_by(company_id: order.company_id)

    unless integration_setting&.settings&.dig("fluid_api_token").present?
      Rails.logger.warn("[SyncTracking] No Fluid API token for company on order #{order.fluid_order_number}")
      return
    end

    fluid_api_token = integration_setting.settings["fluid_api_token"]
    order_service = FluidApi::Commerce::OrderService.new(fluid_api_token)

    # Fetch order items from Fluid
    fluid_response = order_service.retrieve_order(id: order.fluid_order_id)
    fluid_order = JSON.parse(fluid_response.body, symbolize_names: true)

    raise "Fluid order not found for #{order.fluid_order_id}" if fluid_order.blank? || fluid_order[:error]

    order_items = fluid_order.dig(:order, :items)
    tracking_number = order.tracking_numbers&.first

    raise "No tracking number for order #{order.fluid_order_number}" if tracking_number.blank?

    # Create fulfillment in Fluid
    order_service.order_fulfillment(
      id: order.fluid_order_id,
      order_items: order_items,
      tracking_number: tracking_number,
    )

    # Mark as synced
    order.update!(tracking_synced_to_fluid: true, tracking_synced_at: Time.current)

    Rails.logger.info("[SyncTracking] Synced to Fluid: #{order.fluid_order_number}")
  end
end
