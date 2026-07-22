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
    # tracking number). Walks all result pages. Returns [] when the order has
    # not shipped or on a non-rate-limit failure; a persistent 429 re-raises so
    # the caller can back off rather than mistake it for "not shipped".
    def all_for_order(shipstation_order_id)
      return [] if shipstation_order_id.blank? || api_key.blank? || api_secret.blank?

      shipments = each_page(orderId: shipstation_order_id)
      shipments.select { |s| !s["voided"] && s["trackingNumber"].present? }
    rescue RateLimitError
      raise
    rescue StandardError => e
      Rails.logger.error("[Shipstation::Shipments] #{e.class}: #{e.message}")
      []
    end

  private

    # Accumulates the "shipments" array across every page ShipStation returns.
    def each_page(query)
      results = []
      page = 1
      loop do
        response = rate_limited_get("#{SHIPSTATION_API_BASE}/shipments", query: query.merge(page: page))
        return results unless response.code == 200

        body = JSON.parse(response.body)
        results.concat(Array(body["shipments"]))
        total_pages = body["pages"].to_i
        break if total_pages <= page || body["shipments"].blank?

        page += 1
      end
      results
    end
  end
end
