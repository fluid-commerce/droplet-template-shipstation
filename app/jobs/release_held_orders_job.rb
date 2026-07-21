# frozen_string_literal: true

# Recurring job that flushes orders held for batching once their batch window
# has elapsed. Each order is resubmitted through Shipstation::CreateOrder with
# respect_hold: false so the batching hold is bypassed.
#
# Orders held with no hold_until (manual-release batching) are left for an
# explicit force-send and are not touched here.
class ReleaseHeldOrdersJob < ApplicationJob
  queue_as :default

  retry_on StandardError, attempts: 3, wait: 30.seconds

  BATCH_SIZE = 100

  def perform
    orders = ShipstationOrder.releasable_for_batch.limit(BATCH_SIZE).includes(:company)
    Rails.logger.info("[ReleaseHeldOrders] Found #{orders.size} orders to release")

    released = 0
    failed = 0

    orders.each do |order|
      release(order)
      released += 1
    rescue StandardError => e
      Rails.logger.error("[ReleaseHeldOrders] Failed to release #{order.fluid_order_number}: #{e.message}")
      failed += 1
    end

    Rails.logger.info("[ReleaseHeldOrders] Completed: #{released} released, #{failed} failed")
  end

private

  def release(order)
    payload = {
      "order" => order.request_payload,
      "company_id" => order.company.fluid_company_id,
    }
    Shipstation::CreateOrder.new(payload, respect_hold: false).call
  end
end
