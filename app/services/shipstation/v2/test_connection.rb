# frozen_string_literal: true

module Shipstation
  module V2
    # Verifies a company's ShipStation V2 API key by making an authenticated
    # read (GET /v2/carriers). Works for both production and TEST_ sandbox keys.
    # Returns { connected:, sandbox: } so the UI can confirm which environment
    # the key targets.
    class TestConnection < BaseService
      attr_reader :api_key

      def initialize(company_id)
        setting = IntegrationSetting.find_by(company_id: company_id)
        @api_key = setting&.v2_api_key
      end

      def call
        return result(false) if api_key.blank?

        response = HTTParty.get("#{SHIPSTATION_V2_API_BASE}/carriers", headers: headers)
        result(response.code == 200)
      rescue StandardError => e
        Rails.logger.error("[Shipstation::V2::TestConnection] #{e.class}: #{e.message}")
        result(false)
      end

    private

      def result(connected)
        { connected: connected, sandbox: api_key.to_s.start_with?("TEST_") }
      end
    end
  end
end
