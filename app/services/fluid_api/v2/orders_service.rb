# frozen_string_literal: true

module FluidApi
  module V2
    class OrdersService < BaseService
      def get_all(params = {})
        response = HTTParty.get(
          "#{FLUID_API_BASE_URL}/v2/orders",
          headers: headers,
          query: params
        )
      end

      def update_external_id(id:, external_id:)
        response = HTTParty.patch(
          "#{FLUID_API_BASE_URL}/v2/orders/#{id}/update_external_id",
          headers: headers,
          body: update_external_id_body(external_id).to_json
        )

        parse_response(response, symbolize_names: true)
      end

    private

      def update_external_id_body(external_id)
        {
          order: {
            external_id: external_id.to_s,
          },
        }
      end
    end
  end
end
