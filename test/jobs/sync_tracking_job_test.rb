require "test_helper"

describe SyncTrackingJob do
  fixtures(:companies, :shipstation_orders)

  let(:acme) { companies(:acme) }
  let(:unsynced_order) { shipstation_orders(:shipped_unsynced) }

  describe "#perform" do
    it "finds orders that need syncing and marks them synced" do
      fluid_body = { order: { id: 100, items: [ { id: 1, quantity: 2 } ] } }.to_json
      fulfillment_body = { order_fulfillment: { id: 1 } }.to_json

      mock_fluid_response = OpenStruct.new(body: fluid_body)
      mock_fulfillment_response = OpenStruct.new(body: fulfillment_body)

      # Stub the service methods at the class level
      FluidApi::Commerce::OrderService.define_method(:retrieve_order) { |**_| mock_fluid_response }
      FluidApi::Commerce::OrderService.define_method(:order_fulfillment) { |**_| mock_fulfillment_response }

      SyncTrackingJob.perform_now

      # Clean up method overrides
      FluidApi::Commerce::OrderService.remove_method(:retrieve_order)
      FluidApi::Commerce::OrderService.remove_method(:order_fulfillment)

      unsynced_order.reload
      _(unsynced_order.tracking_synced_to_fluid).must_equal true
      _(unsynced_order.tracking_synced_at).wont_be_nil
    end

    it "skips already-synced orders" do
      synced_order = shipstation_orders(:shipped_synced)
      original_synced_at = synced_order.tracking_synced_at

      fluid_body = { order: { id: 100, items: [ { id: 1, quantity: 2 } ] } }.to_json
      FluidApi::Commerce::OrderService.define_method(:retrieve_order) { |**_| OpenStruct.new(body: fluid_body) }
      FluidApi::Commerce::OrderService.define_method(:order_fulfillment) { |**_| OpenStruct.new(body: "{}") }

      SyncTrackingJob.perform_now

      FluidApi::Commerce::OrderService.remove_method(:retrieve_order)
      FluidApi::Commerce::OrderService.remove_method(:order_fulfillment)

      synced_order.reload
      _(synced_order.tracking_synced_at).must_equal original_synced_at
    end

    it "continues processing when one order fails" do
      FluidApi::Commerce::OrderService.define_method(:retrieve_order) { |**_| raise "Fluid API down" }

      SyncTrackingJob.perform_now

      FluidApi::Commerce::OrderService.remove_method(:retrieve_order)

      unsynced_order.reload
      _(unsynced_order.tracking_synced_to_fluid).must_equal false
    end
  end
end
