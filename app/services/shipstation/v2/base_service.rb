# frozen_string_literal: true

module Shipstation
  module V2
    # Base for the ShipStation V2 (ShipEngine-powered) API. Unlike V1's HTTP
    # Basic auth (base64 api_key:api_secret), V2 authenticates with a single
    # `API-Key` header. Sandbox is not a separate host — a `TEST_`-prefixed key
    # simply targets the sandbox environment on the same base URL.
    class BaseService
      SHIPSTATION_V2_API_BASE = "https://api.shipstation.com/v2"

      def headers
        {
          "API-Key" => api_key,
          "Content-Type" => "application/json",
        }
      end
    end
  end
end
