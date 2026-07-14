# frozen_string_literal: true

module Shipstation
  class SyncShippedOrder < BaseService
    attr_reader :payload, :api_key, :api_secret, :company, :company_id

    def initialize(payload, company_id)
      @payload = payload
      @company_id = company_id
      initialize_ss_credentials(company_id)
    end

    def call
      ss_order = retrieve_ss_order
      raise "No shipment found in ShipStation for batch #{batch_id}" if ss_order.nil?

      fluid_order_id = ss_order.dig("shipments", 0, "orderKey")
      tracking_number = ss_order.dig("shipments", 0, "trackingNumber")
      carrier = ss_order.dig("shipments", 0, "carrierCode")

      raise "No orderKey in ShipStation shipment for batch #{batch_id}" if fluid_order_id.blank?

      # Update local order record with tracking info
      local_order = ShipstationOrder.find_by(fluid_order_id: fluid_order_id, company_id: company_id)

      if local_order
        existing_tracking = local_order.tracking_numbers || []
        updated_tracking = if existing_tracking.include?(tracking_number)
          existing_tracking
        else
          existing_tracking + [ tracking_number ]
        end

        local_order.update!(
          status: "SHIPPED",
          tracking_numbers: updated_tracking,
          carrier: carrier,
          shipped_at: Time.current,
        )

        # Idempotency guard: skip Fluid sync if already done
        if local_order.tracking_synced_to_fluid
          Rails.logger.info("[SyncShippedOrder] Tracking already synced to Fluid for order #{fluid_order_id}, skipping")
          return local_order
        end
      end

      # Sync fulfillment to Fluid
      fluid_order = retrieve_fluid_order(fluid_order_id)
      raise "Fluid order not found for ID #{fluid_order_id}" if fluid_order.nil?

      create_fulfillment(fluid_order: fluid_order, ss_order: ss_order)

      # Mark as synced
      local_order&.update!(tracking_synced_to_fluid: true, tracking_synced_at: Time.current)

      Rails.logger.info("[SyncShippedOrder] Synced tracking to Fluid for order #{fluid_order_id}")
      local_order
    end

  private

    def retrieve_ss_order
      shipment_response = ss_shipments(batch_id)
      return nil if shipment_response.nil?

      fluid_order_number = shipment_response.dig("shipments", 0, "orderNumber")
      fluid_order_id = shipment_response.dig("shipments", 0, "orderKey")

      if fluid_order_number.blank? && fluid_order_id.blank?
        Rails.logger.info("[SyncShippedOrder] No order found in ShipStation with batch_id #{batch_id}")
        return nil
      end

      shipment_response
    end

    ALLOWED_SHIPSTATION_HOSTS = %w[
      ssapi.shipstation.com
      ssapi6.shipstation.com
    ].freeze

    def batch_id
      uri = URI.parse(payload)
      validate_resource_url!(uri)
      query_params = Rack::Utils.parse_query(uri.query)
      query_params["batchId"]
    end

    def validate_resource_url!(uri)
      unless uri.scheme == "https" && ALLOWED_SHIPSTATION_HOSTS.include?(uri.host)
        raise "Invalid resource_url host: #{uri.host}. Must be an official ShipStation API endpoint."
      end
    end

    def ss_shipments(batch_id)
      response = HTTParty.get("#{SHIPSTATION_API_BASE}/shipments",
        query: { batchId: batch_id },
        headers: headers)

      unless response.success?
        raise "ShipStation API request failed with status #{response.code}: #{response.message}"
      end

      response
    end

    def retrieve_fluid_order(fluid_order_id)
      fluid_order = fluid_commerce_order_service.retrieve_order(id: fluid_order_id)
      parsed_fluid_order = JSON.parse(fluid_order.body, symbolize_names: true)

      if parsed_fluid_order.blank? || parsed_fluid_order[:error]
        Rails.logger.info("[SyncShippedOrder] No Fluid order found for ID #{fluid_order_id}")
        return nil
      end

      parsed_fluid_order
    end

    def initialize_ss_credentials(company_id)
      @company = Company.find(company_id)
      raise "Company not found for ID: #{company_id}" unless company

      integration_setting = IntegrationSetting.find_by(company_id: company.id)
      raise "Integration settings not found for company: #{company.id}" unless integration_setting

      @api_key = integration_setting.settings["api_key"]
      @api_secret = integration_setting.settings["api_secret"]

      if @api_key.blank? || @api_secret.blank?
        raise "Missing API credentials for company: #{company_id}"
      end
    end

    def create_fulfillment(fluid_order:, ss_order:)
      fluid_order_id = fluid_order.dig(:order, :id)
      order_items = fluid_order.dig(:order, :items)
      tracking_number = ss_order.dig("shipments", 0, "trackingNumber")

      fulfillment_response = fluid_commerce_order_service.order_fulfillment(
        id: fluid_order_id,
        order_items: order_items,
        tracking_number: tracking_number,
      )
      parsed_fulfillment_response = JSON.parse(fulfillment_response.body, symbolize_names: true)

      if parsed_fulfillment_response.blank? || parsed_fulfillment_response[:error]
        raise "Failed to fulfill order #{fluid_order_id} in Fluid: #{parsed_fulfillment_response}"
      end

      parsed_fulfillment_response
    end

    def fluid_commerce_order_service
      @fluid_commerce_order_service ||= FluidApi::Commerce::OrderService.new(company.authentication_token)
    end
  end
end
