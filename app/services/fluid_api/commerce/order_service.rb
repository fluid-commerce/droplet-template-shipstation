module FluidApi
  module Commerce
    class OrderService < BaseService
      def retrieve_order(id:)
        response = HTTParty.get(
          "#{FLUID_API_BASE_URL}/v202506/orders/#{id}",
          headers: headers
        )
      end

      def order_fulfillment(id:, order_items:, tracking_number:)
        response = HTTParty.post(
          "#{FLUID_API_BASE_URL}/order_fulfillments",
          headers: headers,
          body: order_fulfillment_body(id, order_items, tracking_number).to_json
        )
      end

      def order_fulfillment_body(id, order_items, tracking_number)
        order_items = order_items.map do |item|
          { item_id: item[:id], quantity: item[:quantity] }
        end

        {
          order_id: id,
          order_items: order_items,
          tracking_informations: [
            {
              tracking_number: tracking_number,
            },
          ],
        }
      end
    end
  end
end
