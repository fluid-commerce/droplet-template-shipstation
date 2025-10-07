module FluidApi
  module Company
    class OrdersService < BaseService
      def update_order(id:, shipped_on:)
        response = HTTParty.put(
          "#{FLUID_API_BASE_URL}/company/orders/#{id}.json",
          headers: headers,
          body: update_order_body(shipped_on).to_json
        )
      end

    private

      def update_order_body(shipped_on)
        {
          order: {
            shipped_on: shipped_on,
          },
        }
      end
    end
  end
end
