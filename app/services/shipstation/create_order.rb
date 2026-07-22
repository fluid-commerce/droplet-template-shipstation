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

    # respect_hold: when false, the per-company batching hold is bypassed so the
    # order is submitted immediately. Used by the batch-release job and manual
    # force-send, which have already decided the order should go out now.
    def initialize(order_params, respect_hold: true)
      @params = order_params["order"].deep_symbolize_keys
      @company_id = order_params["company_id"]
      @company = Company.find_by(fluid_company_id: @company_id)
      @company_name = company&.name
      @respect_hold = respect_hold

      @integration_setting = IntegrationSetting.find_by(company_id: company.id)
      raise "Integration settings not found for company: #{company.id}" unless @integration_setting

      @api_key = @integration_setting.settings["api_key"]
      @api_secret = @integration_setting.settings["api_secret"]
    end

    def call
      # Record the shipping method at intake (before any hold) so the admin can
      # map methods on held/unpaid orders, not just shipped ones.
      record_seen_shipping_method

      # Orders that are neither fulfillable nor awaiting payment (cancelled,
      # refunded, …) are not sent to ShipStation. If we were already tracking the
      # order (e.g. it was HELD and then cancelled in Fluid), mark it CANCELLED so
      # a later release doesn't ship it from a stale payload.
      if unfulfillable_status?
        handle_unfulfillable_order
        Rails.logger.warn("[CreateOrder] skipping #{params[:order_number]} with status #{order_status.inspect}")
        return Result.new(true, { skipped: "status=#{order_status}" }, nil)
      end

      ss_order = find_or_create_local_order

      # Serialize all decisions/writes for this one order so concurrent
      # order.created / order.updated / release-job invocations can't double-send.
      result = nil
      ss_order.with_lock do
        result = decide_and_process(ss_order)
      end
      result
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

    def decide_and_process(ss_order)
      # Idempotency: never resubmit an order already sent to ShipStation. This
      # also makes order.updated / repeated releases safe.
      if SUBMITTED_STATUSES.include?(ss_order.status)
        return Result.new(true, { skipped: "already #{ss_order.status}" }, nil)
      end

      # Hold unpaid orders instead of sending. An order.updated webhook releases
      # them (calls this service again) once the status becomes fulfillable.
      if awaiting_payment?
        ss_order.update!(status: "AWAITING_PAYMENT", last_error: nil, last_error_at: nil)
        Rails.logger.info("[CreateOrder] holding #{params[:order_number]} as AWAITING_PAYMENT")
        return Result.new(true, { held: true }, nil)
      end

      # Batching: park the order as HELD instead of submitting.
      # ReleaseHeldOrdersJob (or a manual force-send) flushes it later.
      if @respect_hold && batching_enabled?
        hold_for_batch(ss_order)
        return Result.new(true, { held_for_batch: true }, nil)
      end

      submit_to_shipstation(ss_order)
    end

    def hold_for_batch(ss_order)
      # Preserve an already-established batch deadline so repeated order.updated
      # events can't postpone the release indefinitely.
      release_at =
        if ss_order.status == "HELD" && ss_order.hold_until.present?
          ss_order.hold_until
        else
          batch_release_at
        end
      ss_order.update!(status: "HELD", hold_until: release_at, last_error: nil, last_error_at: nil)
      Rails.logger.info("[CreateOrder] batch-holding #{params[:order_number]} (release: #{release_at || 'manual'})")
    end

    def submit_to_shipstation(ss_order)
      response = create_order_in_shipstation
      body = response.parsed_response
      shipstation_order_id = body.is_a?(Hash) ? body["orderId"] : nil

      return record_submit_failure(ss_order, response) if shipstation_order_id.blank?

      # A concurrent shipment webhook may have already advanced this to SHIPPED;
      # don't regress a terminal status.
      unless ss_order.status == "SHIPPED"
        ss_order.update!(
          status: "SUBMITTED",
          shipstation_order_id: shipstation_order_id.to_s,
          response_payload: body,
        )
      end

      sync_external_id_to_fluid(shipstation_order_id)

      Result.new(true, { shipstation_order_id: shipstation_order_id }, nil)
    end

    # ShipStation rejected the order (or returned no orderId). Record the failure
    # with the real reason so it surfaces in the Activity tab, then decide whether
    # to retry:
    #   * 4xx (or a 2xx with no orderId) is a permanent data problem — a bad
    #     serviceCode, missing field, etc. Retrying can't fix it, so we return a
    #     failure Result WITHOUT raising. Raising would unwind through
    #     WebhookEventJob's surrounding transaction and roll back this very FAILED
    #     record (erasing the audit trail), and would burn all 5 job retries.
    #   * 5xx is transient — raise so the job retries with backoff.
    def record_submit_failure(ss_order, response)
      detail = shipstation_error_detail(response)
      ss_order.update!(
        status: "FAILED",
        last_error: detail,
        last_error_at: Time.current,
        retry_count: ss_order.retry_count + 1,
      )
      Rails.logger.error("[CreateOrder] #{params[:order_number]} rejected by ShipStation: #{detail}")

      raise "ShipStation error submitting #{params[:order_number]}: #{detail}" if response.code.to_i >= 500

      Result.new(false, nil, detail)
    end

    # Human-readable reason from a ShipStation response, e.g.
    # "ShipStation 400: Invalid serviceCode".
    def shipstation_error_detail(response)
      body = response.parsed_response
      message =
        if body.is_a?(Hash)
          body["Message"] || body["message"] || body["ExceptionMessage"] || body.to_json
        else
          body.to_s.presence || "no response body"
        end
      "ShipStation #{response.code}: #{message}".truncate(1000)
    end

    # Best-effort: the order is already in ShipStation, so a Fluid sync failure
    # must not raise (which would mark the order FAILED and re-submit it).
    def sync_external_id_to_fluid(shipstation_order_id)
      FluidApi::V2::OrdersService.new(company.authentication_token)
        .update_external_id(id: params[:id], external_id: shipstation_order_id)
    rescue StandardError => e
      Rails.logger.error("[CreateOrder] external id sync failed for #{params[:order_number]}: #{e.message}")
    end

    def record_seen_shipping_method
      return if shipping_title.blank?

      SeenShippingMethod.record!(company: company, title: shipping_title, order_number: params[:order_number])
    end

    # Fluid reports the order is no longer fulfillable (cancelled/refunded/…).
    # Cancel it wherever it lives:
    #   * never sent to ShipStation  -> mark the local record CANCELLED
    #   * already SHIPPED / cancelled -> leave it (never recall a shipped order)
    #   * submitted to ShipStation    -> cancel it there too, UNLESS it already
    #     has a label (ShipStation moves labeled orders to "shipped"); in that
    #     case leave it and record why.
    def handle_unfulfillable_order
      order = company.shipstation_orders.find_by(fluid_order_id: params[:id])
      return unless order
      return if order.status == "CANCELLED"
      return if order.status == "SHIPPED"

      if order.shipstation_order_id.blank?
        order.update!(status: "CANCELLED", last_error: "Fluid order status: #{order_status}")
        return
      end

      case Shipstation::CancelOrder.new(company.id).call(order.shipstation_order_id)
      when :skipped_has_label
        order.update!(
          last_error: "Fluid order #{order_status}, but the ShipStation order already has a label — not cancelled",
          last_error_at: Time.current,
        )
        Rails.logger.warn("[CreateOrder] #{params[:order_number]} unfulfillable but already labeled in ShipStation")
      else
        order.update!(status: "CANCELLED", last_error: "Fluid order status: #{order_status}")
        Rails.logger.info("[CreateOrder] cancelled #{params[:order_number]} in ShipStation (#{order_status})")
      end
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

    def batching_enabled?
      @integration_setting.hold_for_batch
    end

    # When a batch window is configured, hold until now + window; otherwise hold
    # indefinitely (nil) for manual release.
    def batch_release_at
      minutes = @integration_setting.batch_window_minutes
      minutes.present? && minutes.positive? ? minutes.to_i.minutes.from_now : nil
    end

    def find_or_create_local_order
      order = ShipstationOrder.find_or_create_by!(
        company: company,
        fluid_order_id: params[:id],
      ) do |o|
        o.fluid_order_number = params[:order_number]
        o.status = "PENDING"
        o.request_payload = params
      end

      # Refresh the stored payload on existing pre-submit records so a later
      # release/resend uses the latest order data and status (e.g. an order held
      # while awaiting_payment must ship from the updated awaiting_shipment
      # payload, not the stale one it was first stored with).
      unless SUBMITTED_STATUSES.include?(order.status)
        order.update!(request_payload: params, fluid_order_number: params[:order_number])
      end

      order
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
      }.merge(shipping_service_fields).merge(store_fields)
    end

    # Assigns the order to the configured ShipStation store, if any. Blank =
    # ShipStation's default store for the API key (unchanged behavior).
    def store_fields
      store_id = @integration_setting.store_id.presence
      return {} unless store_id

      { advancedOptions: { storeId: store_id.to_i } }
    end

    # Resolves the Fluid order's shipping method title to ShipStation service
    # fields. The title is always passed as requestedShippingService (ShipStation
    # automation rules can key off it); carrier/service/package codes are added
    # only when the admin has configured a mapping for the title.
    def shipping_service_fields
      title = shipping_title
      return {} if title.blank?

      fields = { requestedShippingService: title }
      mapping = company.shipping_method_mappings.find_by(fluid_shipping_title: title)
      unless mapping
        Rails.logger.warn("[CreateOrder] no shipping mapping for #{title.inspect}")
        return fields
      end

      # ShipStation rejects carrierCode unless a valid serviceCode rides with it
      # ("Invalid serviceCode", HTTP 400), so send carrier+service only as a
      # complete pair. A carrier without a service falls back to
      # requestedShippingService alone — which ShipStation accepts (the order
      # lands with no pre-assigned carrier) rather than failing the whole push.
      if mapping.carrier_code.present? && mapping.service_code.present?
        fields[:carrierCode] = mapping.carrier_code
        fields[:serviceCode] = mapping.service_code
        fields[:packageCode] = mapping.package_code if mapping.package_code.present?
      elsif mapping.carrier_code.present?
        Rails.logger.warn(
          "[CreateOrder] mapping for #{title.inspect} has carrier " \
          "#{mapping.carrier_code.inspect} but no service_code; sending " \
          "requestedShippingService only (ShipStation requires carrier + service together)",
        )
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
