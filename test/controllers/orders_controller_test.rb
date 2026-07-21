require "test_helper"

# Stand-in for the Fluid orders client so resend doesn't hit the network.
class ResendFakeOrdersService
  def update_external_id(*, **)
    true
  end
end

describe OrdersController do
  fixtures(:companies)

  let(:company) { companies(:acme) }
  let(:other) { companies(:globex) }
  let(:dri) { company.droplet_installation_uuid }
  let(:xhr) { { "X-Requested-With" => "XMLHttpRequest" } }

  before do
    company.create_integration_setting!(settings: { "api_key" => "k", "api_secret" => "s" })
  end

  def held_order(company:, id: 700)
    company.shipstation_orders.create!(
      fluid_order_id: id, fluid_order_number: "A-#{id}", status: "HELD", hold_until: nil,
      request_payload: {
        "id" => id, "order_number" => "A-#{id}", "items" => [],
        "ship_to" => { "name" => "X" }, "status" => "awaiting_shipment",
      },
    )
  end

  it "requires the XHR header" do
    get orders_url(dri: dri)
    must_respond_with :unauthorized
  end

  it "lists only the current company's orders" do
    mine = held_order(company: company, id: 701)
    theirs = held_order(company: other, id: 702)
    get orders_url(dri: dri), headers: xhr
    must_respond_with :success
    ids = JSON.parse(response.body)["orders"].map { |o| o["id"] }
    _(ids).must_include mine.id
    _(ids).wont_include theirs.id
  end

  it "resends a held order, bypassing the hold" do
    order = held_order(company: company, id: 703)
    HTTParty.stub(:post, ->(*_a, **_k) { { "orderId" => 999 } }) do
      FluidApi::V2::OrdersService.stub(:new, ResendFakeOrdersService.new) do
        post resend_order_url(order, dri: dri), headers: xhr
      end
    end
    must_respond_with :success
    _(order.reload.status).must_equal "SUBMITTED"
  end

  it "rejects resending an order already SUBMITTED" do
    order = company.shipstation_orders.create!(
      fluid_order_id: 704, fluid_order_number: "A-704", status: "SUBMITTED",
    )
    post resend_order_url(order, dri: dri), headers: xhr
    must_respond_with :unprocessable_entity
    _(order.reload.status).must_equal "SUBMITTED"
  end

  it "does not resend another company's order" do
    order = held_order(company: other, id: 705)
    post resend_order_url(order, dri: dri), headers: xhr
    must_respond_with :not_found
  end
end
