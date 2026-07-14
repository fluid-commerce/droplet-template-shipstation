# frozen_string_literal: true

module Shipstation
  # Verifies a company's stored ShipStation credentials by making an
  # authenticated read-only request. Returns true when ShipStation accepts the
  # credentials, false otherwise (missing creds, auth failure, or network error).
  class TestConnection < BaseService
    attr_reader :api_key, :api_secret

    def initialize(company_id)
      integration_setting = IntegrationSetting.find_by(company_id: company_id)
      @api_key = integration_setting&.settings&.dig("api_key")
      @api_secret = integration_setting&.settings&.dig("api_secret")
    end

    def call
      return false if api_key.blank? || api_secret.blank?

      response = HTTParty.get("#{SHIPSTATION_API_BASE}/carriers", headers: headers)
      response.code == 200
    rescue StandardError => e
      Rails.logger.error("[Shipstation::TestConnection] #{e.class}: #{e.message}")
      false
    end
  end
end
