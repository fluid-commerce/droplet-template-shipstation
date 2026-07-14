# frozen_string_literal: true

module Shipstation
  class CreateOrder < BaseService
    attr_reader :params, :api_key, :api_secret, :company_name, :company

    # ShipStation's V1 API base is the same host for every store; the store is
    # identified by the API key/secret, not the URL.
    SHIPSTATION_API_BASE = "https://ssapi.shipstation.com"

    def initialize(order_params)
      @params = order_params["order"].deep_symbolize_keys
      @company_id = order_params["company_id"]
      @company = Company.find_by(fluid_company_id: @company_id)
      @company_name = company&.name

      integration_setting = IntegrationSetting.find_by(company_id: company.id)
      raise "Integration settings not found for company: #{company.id}" unless integration_setting

      @api_key = integration_setting.settings["api_key"]
      @api_secret = integration_setting.settings["api_secret"]
    end

    def call
      # Create local order record for tracking
      ss_order = find_or_create_local_order

      order_response = create_order_in_shipstation
      shipstation_order_id = order_response["orderId"]

      unless shipstation_order_id.present?
        ss_order.update!(
          status: "FAILED",
          last_error: "ShipStation returned no orderId",
          last_error_at: Time.current,
          retry_count: ss_order.retry_count + 1,
        )
        raise "Failed to create order in ShipStation: no orderId returned"
      end

      # Update local record with ShipStation response
      ss_order.update!(
        status: "SUBMITTED",
        shipstation_order_id: shipstation_order_id.to_s,
        response_payload: order_response,
      )

      # Update Fluid with external ID using the droplet install token
      fluid_service = FluidApi::V2::OrdersService.new(company.authentication_token)
      fluid_service.update_external_id(id: params[:id], external_id: shipstation_order_id)

      Result.new(true, { shipstation_order_id: shipstation_order_id }, nil)
    rescue StandardError => e
      # Update local record on failure (if it exists)
      if defined?(ss_order) && ss_order&.persisted?
        ss_order.update(
          status: "FAILED",
          last_error: e.message,
          last_error_at: Time.current,
          retry_count: ss_order.retry_count + 1,
        )
      end
      raise
    end

  private

    def find_or_create_local_order
      ShipstationOrder.find_or_create_by!(
        company: company,
        fluid_order_id: params[:id],
      ) do |order|
        order.fluid_order_number = params[:order_number]
        order.status = "PENDING"
        order.request_payload = params
      end
    end

    def create_order_in_shipstation
      HTTParty.post("#{SHIPSTATION_API_BASE}/orders/createorder", {
                      headers: headers,
                      body: shipstation_payload.to_json,
                    })
    end

    def shipstation_payload
      {
        orderNumber: params[:order_number],
        orderKey: params[:id],
        orderDate: params[:created_at],
        orderStatus: "awaiting_shipment",
        customerUsername: params[:email],
        customerEmail: params[:email],
        billTo: bill_to_payload,
        shipTo: ship_to_payload,
        items: shipstation_items,
        amountPaid: params[:amount],
        taxAmount: params[:tax],
        customerNotes: params[:notes],
        internalNotes: params[:notes],
      }
    end

    def bill_to_payload
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
        residential: true,
      }
    end

    def shipstation_items
      params[:items].map do |item|
        {
          lineItemKey: item[:id].to_s,
          sku: item[:sku],
          name: item[:title],
          imageUrl: item.dig(:product, :image_url),
          quantity: item[:quantity],
          unitPrice: item[:price],
          taxAmount: item[:tax],
          productId: item.dig(:product, :id),
          fulfillmentSku: item.dig(:product, :sku),
          adjustment: false,
        }
      end
    end

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
