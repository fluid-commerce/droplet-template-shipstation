# frozen_string_literal: true

# Recurring job that keeps Fluid's fulfillment/tracking in sync with ShipStation.
#
# ShipStation does not push a shipment webhook to the droplet (none is
# registered), so this job POLLS: it asks ShipStation whether each submitted
# order has shipped, records the tracking locally, then pushes a fulfillment to
# Fluid. It also retries the Fluid push for any order that has tracking but
# whose earlier push failed.
#
# Schedule via Solid Queue's recurring tasks (config/recurring.yml).
class SyncTrackingJob < ApplicationJob
  queue_as :default

  retry_on StandardError, attempts: 3, wait: 30.seconds

  BATCH_SIZE = 100

  def perform
    discover_shipped_orders
    push_tracking_to_fluid
  end

private

  # Ask ShipStation which submitted orders have shipped and record the tracking
  # locally. A newly-SHIPPED order then flows into push_tracking_to_fluid below
  # in this same run.
  def discover_shipped_orders
    orders = ShipstationOrder.pollable_for_tracking.limit(BATCH_SIZE).includes(:company)
    discovered = 0

    orders.find_each do |order|
      shipments = Shipstation::Shipments.new(order.company_id).all_for_order(order.shipstation_order_id)
      next if shipments.empty?

      order.update!(
        status: "SHIPPED",
        tracking_numbers: shipments.map { |s| s["trackingNumber"] }.compact.uniq,
        carrier: shipments.first["carrierCode"],
        shipped_at: Time.current,
      )
      discovered += 1
      Rails.logger.info(
        "[SyncTracking] Discovered #{shipments.size} shipment(s) for #{order.fluid_order_number}",
      )
    rescue StandardError => e
      Rails.logger.error("[SyncTracking] Discover failed for order #{order.fluid_order_number}: #{e.message}")
    end

    Rails.logger.info("[SyncTracking] Discovered #{discovered} newly-shipped orders")
  end

  def push_tracking_to_fluid
    orders = ShipstationOrder.needs_tracking_sync.limit(BATCH_SIZE).includes(:company)

    Rails.logger.info("[SyncTracking] Found #{orders.count} orders to sync to Fluid")

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

  def sync_order(order)
    authentication_token = order.company&.authentication_token

    if authentication_token.blank?
      Rails.logger.warn("[SyncTracking] No authentication token for company on order #{order.fluid_order_number}")
      return
    end

    order_service = FluidApi::Commerce::OrderService.new(authentication_token)

    # Fetch order items from Fluid
    fluid_response = order_service.retrieve_order(id: order.fluid_order_id)
    fluid_order = JSON.parse(fluid_response.body, symbolize_names: true)

    raise "Fluid order not found for #{order.fluid_order_id}" if fluid_order.blank? || fluid_order[:error]

    order_items = fluid_order.dig(:order, :items)
    tracking_numbers = Array(order.tracking_numbers).compact_blank

    raise "No tracking number for order #{order.fluid_order_number}" if tracking_numbers.empty?

    # One tracking_informations entry per package so Fluid records every
    # tracking number, each tagged with the carrier for tracking-link building.
    carrier = fluid_carrier(order.carrier)
    tracking_informations = tracking_numbers.map do |number|
      { tracking_number: number, shipping_carrier: carrier }.compact
    end

    order_service.order_fulfillment(
      id: order.fluid_order_id,
      order_items: order_items,
      tracking_informations: tracking_informations,
    )

    # Mark as synced
    order.update!(tracking_synced_to_fluid: true, tracking_synced_at: Time.current)

    Rails.logger.info("[SyncTracking] Synced to Fluid: #{order.fluid_order_number}")
  end

  # Normalize a ShipStation carrierCode (fedex, ups_walleted, stamps_com, …) to
  # a carrier name Fluid recognizes for tracking-URL generation. Unknown codes
  # pass through (Fluid simply won't build a URL) rather than being dropped.
  def fluid_carrier(carrier_code)
    case carrier_code.to_s.downcase
    when /fedex/ then "fedex"
    when /ups/ then "ups"
    when /usps|stamps|postal/ then "usps"
    when /dhl/ then "dhl"
    else carrier_code.presence
    end
  end
end
