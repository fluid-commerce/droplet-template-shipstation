# frozen_string_literal: true

module Shipstation
  class CreateOrder
    attr_reader :params, :base_url, :api_key, :api_secret, :fluid_api_token, :company_name

    def initialize(order_params, company_id)
      @params = order_params['order'].to_unsafe_h.deep_symbolize_keys
      @company_name = Company.find(company_id)&.name

      integration_setting = IntegrationSetting.find_by(company_id: company_id)
      @base_url = integration_setting.settings['api_base_url']
      @api_key = integration_setting.settings['api_key']
      @api_secret = integration_setting.settings['api_secret']
      @fluid_api_token = integration_setting.settings['fluid_api_token']
    end

    def call
      order_response = create_order_in_shipstation

      shipstation_order_id = order_response['orderId']

      return Result.new(false, nil, 'Failed to create order in ShipStation') unless shipstation_order_id.present?

      begin
        fluid_service = FluidApi::V2::OrdersService.new(fluid_api_token)
        fluid_service.update_order(id: params[:id], external_id: shipstation_order_id)

        Result.new(true, { shipstation_order_id: shipstation_order_id }, nil)
      rescue StandardError => e
        Result.new(false, nil, "Failed to update order in Fluid: #{e.message}")
      end
    end

    private

    def headers
      {
        'Authorization' => generate_auth_header,
        'Content-Type' => 'application/json'
      }
    end

    def generate_auth_header
      credentials = Base64.encode64("#{api_key}:#{api_secret}").gsub("\n", '')
      "Basic #{credentials}"
    end

    def create_order_in_shipstation
      url = "#{base_url}/orders/createorder"

      HTTParty.post(url, {
                      headers: headers,
                      body: shipstation_payload.to_json
                    })
    end

    def shipstation_payload
      {
        orderNumber: params[:id],
        orderDate: params[:created_at],
        orderStatus: 'awaiting_shipment',
        customerUsername: params[:email],
        customerEmail: params[:email],
        billTo: bill_to_payload,
        shipTo: ship_to_payload,
        items: shipstation_items,
        amountPaid: params[:amount],
        taxAmount: params[:tax],
        customerNotes: params[:notes],
        internalNotes: params[:notes]
      }
    end

    def bill_to_payload
      # we don't have billTo in the payload, so we use shipTo
      ship_to_payload
    end

    def ship_to_payload
      {
        name: params.dig(:ship_to, :name),
        company: company_name,
        street1: params.dig(:ship_to, :address1),
        street2: params.dig(:ship_to, :address2),
        city: params.dig(:ship_to, :city),
        state: params.dig(:ship_to, :state),
        postalCode: params.dig(:ship_to, :postal_code),
        country: params.dig(:ship_to, :country_code),
        phone: params[:phone],
        residential: true
      }
    end

    def shipstation_items
      params[:items].map do |item|
        {
          lineItemKey: 'vd08-MSLbtx',
          sku: item[:sku],
          name: item[:title],
          imageUrl: item.dig(:product, :image_url),
          quantity: item[:quantity],
          unitPrice: item[:price],
          taxAmount: item[:tax],
          productId: item.dig(:product, :id),
          fulfillmentSku: item.dig(:product, :sku),
          adjustment: false
        }
      end
    end

    # Simple result object to match controller expectations
    class Result
      attr_reader :success, :data, :error

      def initialize(success, data, error)
        @success = success
        @data = data
        @error = error
      end

      def success?
        success
      end
    end
  end
end
