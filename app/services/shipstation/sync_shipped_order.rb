module Shipstation
  class SyncShippedOrder
    attr_reader :payload, :api_key, :api_secret, :fluid_api_token

    def initialize(payload, company_id)
      @payload = payload
      initialize_ss_credentials(company_id)
    end
  end

  def call
    begin
      shipment_response = ss_shipments(batch_id)

      if shipment_response.nil?
        Rails.logger.error("Failed to fetch shipments from ShipStation API for batch_id #{batch_id}")
        return
      end

      ss_order_id = shipment_response.dig("shipments",0,"orderId")

      if ss_order_id.blank?
        Rails.logger.info("No order found in ShipStation with batch_id #{batch_id}")
        return
      end

      fluid_order = fluid_order(ss_order_id)

      if fluid_order.blank?
        Rails.logger.info("No Fluid order found for ShipStation order ID #{ss_order_id}")
        return
      end

      fluid_order_id = fluid_order['id']

      # update fluid order with ship date
      shipped_on = Date.current.strftime("%Y-%m-%d")
      fluid_company_order_service.update_order(id: fluid_order_id, shipped_on: shipped_on)
    rescue StandardError => e
      Rails.logger.error("Error syncing shipped order: #{e.message} - SyncShippedOrder")
      return
    end
  end

  private

  def initialize_ss_credentials(company_id)
    company = Company.find_by(fluid_company_id: company_id)
    integration_setting = IntegrationSetting.find_by(company_id: company.id)

    @api_key = integration_setting.settings["api_key"]
    @api_secret = integration_setting.settings["api_secret"]
    @fluid_api_token = integration_setting.settings["fluid_api_token"]
  end

  def batch_id
    # Extract batchId from the resource_url
    uri = URI.parse(payload)
    query_params = Rack::Utils.parse_query(uri.query)
    batch_id = query_params['batchId']
  end

  # batch_id=23646326
  def ss_shipments(batch_id)
    response = HTTParty.get('https://ssapi.shipstation.com/shipments',
      query: { batchId: batch_id },
      headers: headers
    )

    unless response.success?
      Rails.logger.error("ShipStation API request failed with status #{response.code}: #{response.message}")
      return nil
    end

    response
  end

  def fluid_commerce_order_service
    @fluid_commerce_order_service ||= FluidApi::V2::OrdersService.new(fluid_api_token)
  end

  def fluid_company_order_service
    @fluid_company_order_service ||= FluidApi::Company::OrdersService.new(fluid_api_token)
  end

  def fluid_order(ss_order_id)
    orders = fluid_order_service.get_all(external_id: ss_order_id)
    orders.find { |order| order[:external_id] == ss_order_id }
  end
end
