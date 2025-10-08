module Shipstation
  class SyncShippedOrder < BaseService
    attr_reader :payload, :api_key, :api_secret, :fluid_api_token

    def initialize(payload, company_id)
      @payload = payload
      initialize_ss_credentials(company_id)
    end

    def call
      begin
        ss_order = retrieve_ss_order
        return nil if ss_order.nil?

        # fluid order id is the order key
        fluid_order_id = ss_order.dig("shipments", 0, "orderKey")

        fluid_order = retrieve_fluid_order(fluid_order_id)
        return nil if fluid_order.nil?

        fulfillment = create_fulfillment(fluid_order:, ss_order:)
        nil if fulfillment.nil?
      rescue StandardError => e
        Rails.logger.error("Error syncing shipped order: #{e.message} - SyncShippedOrder")
        nil
      end
    end

  private

    def retrieve_ss_order
      shipment_response = ss_shipments(batch_id)

      if shipment_response.nil?
        Rails.logger.error("Failed to fetch shipments from ShipStation API for batch_id #{batch_id}")
        return nil
      end

      fluid_order_number = shipment_response.dig("shipments", 0, "orderNumber")
      fluid_order_id = shipment_response.dig("shipments", 0, "orderKey")

      if fluid_order_number.blank? && fluid_order_id.blank?
        Rails.logger.info("No order found in ShipStation with batch_id #{batch_id}")
        return nil
      end

      shipment_response
    end

    def batch_id
      # Extract batchId from the resource_url
      uri = URI.parse(payload)
      query_params = Rack::Utils.parse_query(uri.query)
      query_params["batchId"]
    end

    # batch_id=23646326
    def ss_shipments(batch_id)
      response = HTTParty.get("https://ssapi.shipstation.com/shipments",
        query: { batchId: batch_id },
        headers: headers
      )

      unless response.success?
        Rails.logger.error("ShipStation API request failed with status #{response.code}: #{response.message}")
        return nil
      end

      response
    end

    def retrieve_fluid_order(fluid_order_id)
      fluid_order = fluid_commerce_order_service.retrieve_order(id: fluid_order_id)
      parsed_fluid_order = JSON.parse(fluid_order.body, symbolize_names: true)

      # Check if the response indicates order not found
      if parsed_fluid_order.blank? || parsed_fluid_order["error"]
        Rails.logger.info("No Fluid order found for ID #{fluid_order_id}")
        return nil
      end

      parsed_fluid_order
    end

    def initialize_ss_credentials(company_id)
      company = Company.find(company_id)
      raise "Company not found for ID: #{company_id}" unless company

      integration_setting = IntegrationSetting.find_by(company_id: company.id)
      raise "Integration settings not found for company: #{company.id}" unless integration_setting

      @api_key = integration_setting.settings["api_key"]
      @api_secret = integration_setting.settings["api_secret"]
      @fluid_api_token = integration_setting.settings["fluid_api_token"]

      if @api_key.blank? || @api_secret.blank? || @fluid_api_token.blank?
        raise "Missing API credentials for company: #{company_id}"
      end
    end

    def create_fulfillment(fluid_order:, ss_order:)
      fluid_order_id = fluid_order.dig(:order, :id)
      order_items = fluid_order.dig(:order, :items)
      tracking_number = ss_order.dig("shipments", 0, "trackingNumber")

      fulfillment_response = fluid_commerce_order_service.order_fulfillment(id: fluid_order_id, order_items:,
tracking_number:)
      parsed_fulfillment_response = JSON.parse(fulfillment_response.body, symbolize_names: true)

      if parsed_fulfillment_response.blank? || parsed_fulfillment_response["error"]
        Rails.logger.info("Failed to fulfill order #{fluid_order_id} in Fluid")
        return nil
      end

      parsed_fulfillment_response
    end

    def fluid_commerce_order_service
      @fluid_commerce_order_service ||= FluidApi::Commerce::OrderService.new(@fluid_api_token)
    end
  end
end
