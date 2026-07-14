module Shipstation
  class BaseService
    # ShipStation's V1 API base is the same host for every store; the store is
    # identified by the API key/secret, not the URL.
    SHIPSTATION_API_BASE = "https://ssapi.shipstation.com"

    def headers
      {
        "Authorization" => generate_auth_header,
        "Content-Type" => "application/json",
      }
    end

    def generate_auth_header
      credentials = Base64.encode64("#{api_key}:#{api_secret}").gsub("\n", "")
      "Basic #{credentials}"
    end
  end
end
