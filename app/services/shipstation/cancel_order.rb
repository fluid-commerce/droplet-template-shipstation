# frozen_string_literal: true

module Shipstation
  # Cancels an order in ShipStation when Fluid reports it is no longer
  # fulfillable — but NEVER touches an order that already has a label or has
  # shipped. In ShipStation, buying/printing a label moves the order to the
  # "shipped" status, so orderStatus is the reliable "has a label" signal.
  #
  # Returns one of:
  #   :cancelled          — order was deleted (soft-cancelled) in ShipStation
  #   :skipped_has_label  — order already shipped/labeled; left untouched
  #   :already_cancelled  — order was already cancelled/inactive
  #   :not_found          — no such order (or missing credentials)
  class CancelOrder < BaseService
    attr_reader :api_key, :api_secret

    # ShipStation orderStatuses that mean a label exists / it has shipped — we
    # must not recall these.
    SHIPPED_STATUSES = %w[shipped].freeze
    CANCELLED_STATUSES = %w[cancelled].freeze

    def initialize(company_id)
      setting = IntegrationSetting.find_by(company_id: company_id)
      @api_key = setting&.settings&.dig("api_key")
      @api_secret = setting&.settings&.dig("api_secret")
    end

    def call(shipstation_order_id)
      return :not_found if shipstation_order_id.blank? || api_key.blank? || api_secret.blank?

      order = fetch_order(shipstation_order_id)
      return :not_found if order.nil?
      return :already_cancelled if CANCELLED_STATUSES.include?(order["orderStatus"])
      return :skipped_has_label if SHIPPED_STATUSES.include?(order["orderStatus"])

      delete_order(shipstation_order_id)
      :cancelled
    end

  private

    def fetch_order(shipstation_order_id)
      response = HTTParty.get("#{SHIPSTATION_API_BASE}/orders/#{shipstation_order_id}", headers: headers)
      return nil if response.code == 404
      raise "ShipStation order fetch failed (#{response.code})" unless response.code == 200

      JSON.parse(response.body)
    end

    # DELETE performs a ShipStation soft-cancel (marks the order inactive), which
    # removes it from the shipping queue so it won't be fulfilled.
    def delete_order(shipstation_order_id)
      response = HTTParty.delete("#{SHIPSTATION_API_BASE}/orders/#{shipstation_order_id}", headers: headers)
      raise "ShipStation order cancel failed (#{response.code})" unless response.code == 200
    end
  end
end
