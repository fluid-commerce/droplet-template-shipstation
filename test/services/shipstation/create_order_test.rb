require "test_helper"

# Stand-in for the Fluid orders client so #call doesn't hit the network when it
# writes the external id back to Fluid.
class FakeOrdersService
  def update_external_id(*, **)
    true
  end
end

class Shipstation::CreateOrderTest < ActiveSupport::TestCase
  fixtures :companies

  setup do
    @company = companies(:acme)
    @company.create_integration_setting!(settings: { "api_key" => "k", "api_secret" => "s" })
  end

  def order_params(metadata: {})
    {
      "company_id" => @company.fluid_company_id,
      "order" => {
        "id" => 555,
        "order_number" => "ORD-555",
        "email" => "a@b.com",
        "items" => [],
        "ship_to" => { "name" => "X" },
        "metadata" => metadata,
      },
    }
  end

  def run_with_captured_body(params)
    captured = nil
    HTTParty.stub(:post, ->(*args, **_kw) { captured = JSON.parse((args[1] || {})[:body]); { "orderId" => 42 } }) do
      FluidApi::V2::OrdersService.stub(:new, FakeOrdersService.new) do
        Shipstation::CreateOrder.new(params).call
      end
    end
    captured
  end

  test "injects mapped carrier/service/package codes and the requested service" do
    @company.shipping_method_mappings.create!(
      fluid_shipping_title: "Ground Shipping",
      carrier_code: "stamps_com",
      service_code: "usps_priority_mail",
      package_code: "package",
    )
    body = run_with_captured_body(
      order_params(metadata: { "shipping" => { "title" => "Ground Shipping" } }),
    )
    _(body["carrierCode"]).must_equal "stamps_com"
    _(body["serviceCode"]).must_equal "usps_priority_mail"
    _(body["packageCode"]).must_equal "package"
    _(body["requestedShippingService"]).must_equal "Ground Shipping"
  end

  test "passes the title as requestedShippingService even with no mapping" do
    body = run_with_captured_body(
      order_params(metadata: { "shipping" => { "title" => "Express" } }),
    )
    _(body["requestedShippingService"]).must_equal "Express"
    _(body.key?("carrierCode")).must_equal false
  end

  test "records the seen shipping method with the order number" do
    run_with_captured_body(order_params(metadata: { "shipping" => { "title" => "Express" } }))
    seen = @company.seen_shipping_methods.find_by(fluid_shipping_title: "Express")
    _(seen).wont_be_nil
    _(seen.example_order_number).must_equal "ORD-555"
  end

  test "sends no shipping fields when the order has no shipping title" do
    body = run_with_captured_body(order_params)
    _(body.key?("requestedShippingService")).must_equal false
    _(body.key?("carrierCode")).must_equal false
  end
end
