# frozen_string_literal: true

module FluidApi
  class BaseService
    include ErrorLogger

    attr_reader :company_token

    FLUID_API_BASE_URL="https://api.fluid.app/api"

    def initialize(company_token)
      @company_token = company_token
    end

    def headers
      {
        Authorization: "Bearer #{company_token}",
        'Content-Type' => 'application/json',
        'x-fluid-client' => 'shipstation-droplet'
      }
    end

    def parse_response(response, symbolize_names: false)
      JSON.parse(response.body, symbolize_names:)
    rescue JSON::ParserError => e
      log_error(e)
      raise
    end
  end
end
