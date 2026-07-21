require "test_helper"

# Stand-in for the Fluid orders client so releasing doesn't hit the network.
class StubOrdersService
  def update_external_id(*, **)
    true
  end
end

class ReleaseHeldOrdersJobTest < ActiveSupport::TestCase
  fixtures :companies

  setup do
    @company = companies(:acme)
    @company.create_integration_setting!(
      settings: { "api_key" => "k", "api_secret" => "s" },
      hold_for_batch: true,
      batch_window_minutes: 30,
    )
  end

  def held_order(hold_until:, id:)
    @company.shipstation_orders.create!(
      fluid_order_id: id,
      fluid_order_number: "H-#{id}",
      status: "HELD",
      hold_until: hold_until,
      request_payload: {
        "id" => id, "order_number" => "H-#{id}", "items" => [],
        "ship_to" => { "name" => "X" }, "status" => "awaiting_shipment",
      },
    )
  end

  test "releases orders past their hold window" do
    due = held_order(hold_until: 1.minute.ago, id: 901)
    HTTParty.stub(:post, ->(*_a, **_k) { { "orderId" => 77 } }) do
      FluidApi::V2::OrdersService.stub(:new, StubOrdersService.new) do
        ReleaseHeldOrdersJob.new.perform
      end
    end
    _(due.reload.status).must_equal "SUBMITTED"
  end

  test "does not release orders whose window is still in the future" do
    future = held_order(hold_until: 1.hour.from_now, id: 902)
    ReleaseHeldOrdersJob.new.perform
    _(future.reload.status).must_equal "HELD"
  end

  test "does not release manual-hold orders with no hold_until" do
    manual = held_order(hold_until: nil, id: 903)
    ReleaseHeldOrdersJob.new.perform
    _(manual.reload.status).must_equal "HELD"
  end
end
