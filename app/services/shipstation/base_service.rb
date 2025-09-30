module Shipstation
  class BaseService
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