# frozen_string_literal: true

module Shipstation
  # Reads shipments for an order from a company's ShipStation account so the
  # tracking-poll job can discover when an order has shipped (ShipStation does
  # not push this to us — no webhook is registered). Best-effort: a missing
  # cred/auth/network failure returns nil rather than raising.
  class Shipments < BaseService
    attr_reader :api_key, :api_secret

    def initialize(company_id)
      setting = IntegrationSetting.find_by(company_id: company_id)
      @api_key = setting&.settings&.dig("api_key")
      @api_secret = setting&.settings&.dig("api_secret")
    end

    # Every non-voided shipment carrying a tracking number for a ShipStation
    # order id (an order can ship in several packages, each with its own
    # tracking number). Returns [] when the order has not shipped or on any
    # failure.
    def all_for_order(shipstation_order_id)
      return [] if shipstation_order_id.blank? || api_key.blank? || api_secret.blank?

      response = HTTParty.get("#{SHIPSTATION_API_BASE}/shipments",
        query: { orderId: shipstation_order_id },
        headers: headers)
      return [] unless response.code == 200

      shipments = JSON.parse(response.body)["shipments"]
      return [] unless shipments.is_a?(Array)

      shipments.select { |s| !s["voided"] && s["trackingNumber"].present? }
    rescue StandardError => e
      Rails.logger.error("[Shipstation::Shipments] #{e.class}: #{e.message}")
      []
    end
  end
end
