require "test_helper"

describe ShipstationOrder do
  fixtures(:companies, :shipstation_orders)

  describe "validations" do
    it "requires fluid_order_id" do
      order = ShipstationOrder.new(company: companies(:acme), fluid_order_number: "ORD-X")
      _(order).wont_be :valid?
      _(order.errors[:fluid_order_id]).must_include "can't be blank"
    end

    it "requires fluid_order_number" do
      order = ShipstationOrder.new(company: companies(:acme), fluid_order_id: 999)
      _(order).wont_be :valid?
      _(order.errors[:fluid_order_number]).must_include "can't be blank"
    end

    it "validates status inclusion" do
      order = ShipstationOrder.new(
        company: companies(:acme),
        fluid_order_id: 999,
        fluid_order_number: "ORD-X",
        status: "INVALID",
      )
      _(order).wont_be :valid?
      _(order.errors[:status]).must_include "is not included in the list"
    end

    it "is valid with required fields" do
      order = ShipstationOrder.new(
        company: companies(:acme),
        fluid_order_id: 999,
        fluid_order_number: "ORD-X",
        status: "PENDING",
      )
      _(order).must_be :valid?
    end
  end

  describe "scopes" do
    it "needs_tracking_sync returns shipped unsynced orders" do
      results = ShipstationOrder.needs_tracking_sync
      _(results).must_include shipstation_orders(:shipped_unsynced)
      _(results).wont_include shipstation_orders(:shipped_synced)
      _(results).wont_include shipstation_orders(:failed_order)
    end

    it "failed returns only failed orders" do
      results = ShipstationOrder.failed
      _(results).must_include shipstation_orders(:failed_order)
      _(results).wont_include shipstation_orders(:shipped_unsynced)
    end

    it "releasable_for_batch returns only due HELD orders" do
      due = ShipstationOrder.create!(company: companies(:acme), fluid_order_id: 8001,
        fluid_order_number: "B-1", status: "HELD", hold_until: 1.minute.ago)
      future = ShipstationOrder.create!(company: companies(:acme), fluid_order_id: 8002,
        fluid_order_number: "B-2", status: "HELD", hold_until: 1.hour.from_now)
      manual = ShipstationOrder.create!(company: companies(:acme), fluid_order_id: 8003,
        fluid_order_number: "B-3", status: "HELD", hold_until: nil)

      results = ShipstationOrder.releasable_for_batch
      _(results).must_include due
      _(results).wont_include future
      _(results).wont_include manual
    end
  end

  it "accepts the HELD status" do
    order = ShipstationOrder.new(company: companies(:acme), fluid_order_id: 7001,
      fluid_order_number: "H-1", status: "HELD")
    _(order).must_be :valid?
  end

  describe "#sendable?" do
    it "returns true for FAILED orders" do
      _(shipstation_orders(:failed_order)).must_be :sendable?
    end

    it "returns true for PENDING orders" do
      _(shipstation_orders(:pending_order)).must_be :sendable?
    end

    it "returns false for SHIPPED orders" do
      _(shipstation_orders(:shipped_unsynced)).wont_be :sendable?
    end
  end
end
