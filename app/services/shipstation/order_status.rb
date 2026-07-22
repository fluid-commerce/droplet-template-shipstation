# frozen_string_literal: true

module Shipstation
  # Looks up whether a ShipStation order has already shipped / been labeled, used
  # to decide if a Fluid-side edit may be re-pushed. Fail-safe: on any error or
  # ambiguity it reports `shipped? == true` so we DON'T overwrite an order we
  # can't confirm is still open.
  class OrderStatus < BaseService
    attr_reader :api_key, :api_secret

    def initialize(company_id)
      setting = IntegrationSetting.find_by(company_id: company_id)
      @api_key = setting&.settings&.dig("api_key")
      @api_secret = setting&.settings&.dig("api_secret")
    end

    def shipped?(shipstation_order_id)
      return false if shipstation_order_id.blank? || api_key.blank? || api_secret.blank?

      response = HTTParty.get("#{SHIPSTATION_API_BASE}/orders/#{shipstation_order_id}", headers: headers)
      return true unless response.code == 200 # unsure -> treat as labeled, skip the update

      JSON.parse(response.body)["orderStatus"] == "shipped"
    rescue StandardError => e
      Rails.logger.error("[Shipstation::OrderStatus] #{e.class}: #{e.message}")
      true
    end
  end
end
