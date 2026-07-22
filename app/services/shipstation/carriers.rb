# frozen_string_literal: true

module Shipstation
  # Reads the connected carriers, services, and packages from a company's
  # ShipStation account so the config UI can offer them as dropdowns instead of
  # free-text codes. All reads are best-effort: a missing-cred/auth/network
  # failure returns [] rather than raising, so the UI degrades to manual entry.
  class Carriers < BaseService
    attr_reader :api_key, :api_secret

    def initialize(company_id)
      setting = IntegrationSetting.find_by(company_id: company_id)
      @api_key = setting&.settings&.dig("api_key")
      @api_secret = setting&.settings&.dig("api_secret")
    end

    # [{ "code" => "fedex", "name" => "FedEx", "nickname" => "..." }, ...]
    def carriers
      get("/carriers")
    end

    def services(carrier_code)
      return [] if carrier_code.blank?

      get("/carriers/listservices", carrierCode: carrier_code)
    end

    def packages(carrier_code)
      return [] if carrier_code.blank?

      get("/carriers/listpackages", carrierCode: carrier_code)
    end

    # [{ "storeId" => 123, "storeName" => "…", "marketplaceName" => "Shopify",
    #    "active" => true }, ...] — the stores orders can be assigned to.
    def stores
      get("/stores", showInactive: false)
    end

  private

    def get(path, query = {})
      return [] if api_key.blank? || api_secret.blank?

      response = HTTParty.get("#{SHIPSTATION_API_BASE}#{path}", headers: headers, query: query)
      return [] unless response.code == 200

      body = JSON.parse(response.body)
      body.is_a?(Array) ? body : []
    rescue StandardError => e
      Rails.logger.error("[Shipstation::Carriers] #{e.class}: #{e.message}")
      []
    end
  end
end
