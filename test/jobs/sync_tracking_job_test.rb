require "test_helper"

describe SyncTrackingJob do
  fixtures(:companies, :shipstation_orders)

  let(:acme) { companies(:acme) }
  let(:unsynced_order) { shipstation_orders(:shipped_unsynced) }

  describe "#perform" do
    it "finds orders that need syncing and marks them synced" do
      mock_setting = OpenStruct.new(settings: { "fluid_api_token" => "test-token" })

      fluid_body = { order: { id: 100, items: [{ id: 1, quantity: 2 }] } }.to_json
      fulfillment_body = { order_fulfillment: { id: 1 } }.to_json

      mock_fluid_response = OpenStruct.new(body: fluid_body)
      mock_fulfillment_response = OpenStruct.new(body: fulfillment_body)

      # Stub the service methods at the class level
      IntegrationSetting.stub(:find_by, mock_setting) do
        FluidApi::Commerce::OrderService.define_method(:retrieve_order) { |**_| mock_fluid_response }
        FluidApi::Commerce::OrderService.define_method(:order_fulfillment) { |**_| mock_fulfillment_response }

        SyncTrackingJob.perform_now

        # Clean up method overrides
        FluidApi::Commerce::OrderService.remove_method(:retrieve_order)
        FluidApi::Commerce::OrderService.remove_method(:order_fulfillment)
      end

      unsynced_order.reload
      _(unsynced_order.tracking_synced_to_fluid).must_equal true
      _(unsynced_order.tracking_synced_at).wont_be_nil
    end

    it "skips already-synced orders" do
      synced_order = shipstation_orders(:shipped_synced)
      original_synced_at = synced_order.tracking_synced_at

      IntegrationSetting.stub(:find_by, nil) do
        SyncTrackingJob.perform_now
      end

      synced_order.reload
      _(synced_order.tracking_synced_at).must_equal original_synced_at
    end

    it "continues processing when one order fails" do
      IntegrationSetting.stub(:find_by, nil) do
        SyncTrackingJob.perform_now
      end

      unsynced_order.reload
      _(unsynced_order.tracking_synced_to_fluid).must_equal false
    end
  end
end
