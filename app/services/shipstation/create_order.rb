# frozen_string_literal: true

module Shipstation
  class CreateOrder < BaseService
    attr_reader :params, :api_key, :api_secret, :company_name, :company

    # Fluid order statuses that are ready to ship. A blank status is treated as
    # fulfillable (older payloads omit it). Anything else that is not awaiting
    # payment is skipped entirely (e.g. cancelled/refunded).
    FULFILLABLE_STATUSES = %w[awaiting_shipment].freeze
    AWAITING_PAYMENT_STATUS = "awaiting_payment"
    # Statuses that mean the order is already in ShipStation — never resend.
    SUBMITTED_STATUSES = %w[SUBMITTED SHIPPED].freeze

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
      # Orders that are neither fulfillable nor awaiting payment (cancelled,
      # refunded, …) are not sent to ShipStation and not tracked locally.
      if unfulfillable_status?
        Rails.logger.info("[CreateOrder] skipping order #{params[:order_number]} with status #{order_status.inspect}")
        return Result.new(true, { skipped: "status=#{order_status}" }, nil)
      end

      # Create local order record for tracking
      ss_order = find_or_create_local_order

      # Idempotency: never resubmit an order already sent to ShipStation. This
      # also makes order.updated safe to fire repeatedly.
      if SUBMITTED_STATUSES.include?(ss_order.status)
        return Result.new(true, { skipped: "already #{ss_order.status}" }, nil)
      end

      # Hold unpaid orders instead of sending. An order.updated webhook releases
      # them (calls this service again) once the status becomes fulfillable.
      if awaiting_payment?
        ss_order.update!(status: "AWAITING_PAYMENT", last_error: nil, last_error_at: nil)
        Rails.logger.info("[CreateOrder] holding order #{params[:order_number]} as AWAITING_PAYMENT")
        return Result.new(true, { held: true }, nil)
      end

      submit_to_shipstation(ss_order)
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

    def submit_to_shipstation(ss_order)
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
    end

    def order_status
      params[:status].to_s
    end

    def unfulfillable_status?
      order_status.present? &&
        !FULFILLABLE_STATUSES.include?(order_status) &&
        order_status != AWAITING_PAYMENT_STATUS
    end

    def awaiting_payment?
      order_status == AWAITING_PAYMENT_STATUS
    end

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
      }.merge(shipping_service_fields)
    end

    # Resolves the Fluid order's shipping method title to ShipStation service
    # fields. The title is always passed as requestedShippingService (ShipStation
    # automation rules can key off it); carrier/service/package codes are added
    # only when the admin has configured a mapping for the title.
    def shipping_service_fields
      title = shipping_title
      return {} if title.blank?

      SeenShippingMethod.record!(company: company, title: title, order_number: params[:order_number])

      fields = { requestedShippingService: title }
      mapping = company.shipping_method_mappings.find_by(fluid_shipping_title: title)
      if mapping
        fields[:carrierCode] = mapping.carrier_code if mapping.carrier_code.present?
        fields[:serviceCode] = mapping.service_code if mapping.service_code.present?
        fields[:packageCode] = mapping.package_code if mapping.package_code.present?
      else
        Rails.logger.warn("[CreateOrder] no shipping mapping for #{title.inspect}")
      end
      fields
    end

    def shipping_title
      params.dig(:metadata, :shipping, :title).presence
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
