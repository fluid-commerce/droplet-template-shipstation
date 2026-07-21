# frozen_string_literal: true

module FluidApi
  module V2
    # Lists a company's configured shipping method names from Fluid so the config
    # UI can suggest them. Uses the droplet install token (orders.view scope).
    # Best-effort: returns [] on any failure so the UI falls back to the
    # auto-tracked "seen" titles / manual entry.
    class ShippingMethodsService < BaseService
      ENDPOINT = "/v2/integrations/shipping_methods"

      # Returns the distinct shipping method names (these match the
      # order.metadata.shipping.title seen on Fluid-calculated shipping).
      def names
        response = HTTParty.get(
          "#{FLUID_API_BASE_URL}#{ENDPOINT}",
          headers: headers,
          query: { per_page: 200 },
        )
        return [] unless response.code.to_i.between?(200, 299)

        extract_methods(parse_response(response)).filter_map { |m| m["name"].presence }.uniq
      rescue StandardError => e
        Rails.logger.error("[FluidApi::ShippingMethodsService] #{e.class}: #{e.message}")
        []
      end

    private

      # The endpoint may wrap the collection under a key or return a bare array;
      # handle the common envelopes without assuming one.
      def extract_methods(body)
        return body if body.is_a?(Array)
        return [] unless body.is_a?(Hash)

        body["shipping_methods"] || body["data"] || []
      end
    end
  end
end
