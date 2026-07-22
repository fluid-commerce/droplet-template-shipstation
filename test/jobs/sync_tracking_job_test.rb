require "test_helper"

# Stand-in for Shipstation::Shipments so the poll phase doesn't hit ShipStation.
class FakeShipments
  def initialize(shipments)
    @shipments = Array(shipments)
  end

  def all_for_order(_shipstation_order_id)
    @shipments
  end
end

describe SyncTrackingJob do
  fixtures(:companies, :shipstation_orders)

  let(:acme) { companies(:acme) }
  let(:unsynced_order) { shipstation_orders(:shipped_unsynced) }
  let(:submitted_order) { shipstation_orders(:submitted_order) }

  # A no-op Fluid client so the push phase never hits the network.
  def stub_fluid_order_service
    body = { order: { id: 500, items: [ { id: 1, quantity: 1 } ] } }.to_json
    FluidApi::Commerce::OrderService.define_method(:retrieve_order) { |**_| OpenStruct.new(body: body) }
    FluidApi::Commerce::OrderService.define_method(:order_fulfillment) { |**_| OpenStruct.new(body: "{}") }
    yield
  ensure
    FluidApi::Commerce::OrderService.remove_method(:retrieve_order)
    FluidApi::Commerce::OrderService.remove_method(:order_fulfillment)
  end

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

  describe "polling ShipStation for shipments" do
    it "discovers a shipped SUBMITTED order and syncs its tracking to Fluid" do
      shipment = { "trackingNumber" => "382763123186", "carrierCode" => "fedex", "voided" => false }

      stub_fluid_order_service do
        Shipstation::Shipments.stub(:new, FakeShipments.new([ shipment ])) do
          SyncTrackingJob.perform_now
        end
      end

      submitted_order.reload
      _(submitted_order.status).must_equal "SHIPPED"
      _(submitted_order.tracking_numbers).must_equal [ "382763123186" ]
      _(submitted_order.carrier).must_equal "fedex"
      _(submitted_order.tracking_synced_to_fluid).must_equal true
      _(submitted_order.tracking_synced_at).wont_be_nil
    end

    it "records every tracking number from a multi-package order" do
      shipments = [
        { "trackingNumber" => "TRK1", "carrierCode" => "fedex", "voided" => false },
        { "trackingNumber" => "TRK2", "carrierCode" => "fedex", "voided" => false },
      ]
      captures = {}
      FluidApi::Commerce::OrderService.define_method(:retrieve_order) do |**_|
        OpenStruct.new(body: { order: { id: 500, items: [] } }.to_json)
      end
      FluidApi::Commerce::OrderService.define_method(:order_fulfillment) do |**kwargs|
        captures[kwargs[:id]] = kwargs[:tracking_informations]
        OpenStruct.new(body: "{}")
      end
      Shipstation::Shipments.stub(:new, FakeShipments.new(shipments)) do
        SyncTrackingJob.perform_now
      end
      FluidApi::Commerce::OrderService.remove_method(:retrieve_order)
      FluidApi::Commerce::OrderService.remove_method(:order_fulfillment)

      _(submitted_order.reload.tracking_numbers).must_equal %w[TRK1 TRK2]
      pushed = captures[submitted_order.fluid_order_id]
      _(pushed.map { |t| t[:tracking_number] }).must_equal %w[TRK1 TRK2]
      _(pushed.map { |t| t[:shipping_carrier] }.uniq).must_equal [ "fedex" ]
    end

    it "leaves a SUBMITTED order untouched when ShipStation has no shipment yet" do
      stub_fluid_order_service do
        Shipstation::Shipments.stub(:new, FakeShipments.new([])) do
          SyncTrackingJob.perform_now
        end
      end

      submitted_order.reload
      _(submitted_order.status).must_equal "SUBMITTED"
      _(submitted_order.tracking_numbers.to_a).must_be_empty
      _(submitted_order.tracking_synced_to_fluid).must_equal false
    end
  end
end
