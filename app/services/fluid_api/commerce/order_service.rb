module FluidApi
  module Commerce
    class OrderService < BaseService
      def retrieve_order(id:)
        response = HTTParty.get(
          "#{FLUID_API_BASE_URL}/v202506/orders/#{id}",
          headers: headers
        )
      end

      # tracking_informations: array of { tracking_number:, shipping_carrier: }
      # (one per package). Fluid uses shipping_carrier to build a tracking URL.
      def order_fulfillment(id:, order_items:, tracking_informations:)
        response = HTTParty.post(
          "#{FLUID_API_BASE_URL}/order_fulfillments",
          headers: headers,
          body: order_fulfillment_body(id, order_items, tracking_informations).to_json
        )
      end

      def order_fulfillment_body(id, order_items, tracking_informations)
        order_items = order_items.map do |item|
          { item_id: item[:id], quantity: item[:quantity] }
        end

        {
          order_id: id,
          order_items: order_items,
          tracking_informations: tracking_informations,
        }
      end
    end
  end
end
