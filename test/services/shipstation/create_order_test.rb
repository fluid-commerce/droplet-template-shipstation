require "test_helper"

# Stand-in for the Fluid orders client so #call doesn't hit the network when it
# writes the external id back to Fluid.
class FakeOrdersService
  def update_external_id(*, **)
    true
  end
end

# Simulates a Fluid external-id sync failure (must not fail the order).
class RaisingOrdersService
  def update_external_id(*, **)
    raise "fluid timeout"
  end
end

# Stand-in for Shipstation::CancelOrder returning a fixed outcome.
class FakeCancel
  def initialize(result)
    @result = result
  end

  def call(_shipstation_order_id)
    @result
  end
end

class Shipstation::CreateOrderTest < ActiveSupport::TestCase
  fixtures :companies

  setup do
    @company = companies(:acme)
    @company.create_integration_setting!(settings: { "api_key" => "k", "api_secret" => "s" })
  end

  def order_params(metadata: {}, status: nil, id: 555, order_number: "ORD-555")
    order = {
      "id" => id,
      "order_number" => order_number,
      "email" => "a@b.com",
      "items" => [],
      "ship_to" => { "name" => "X" },
      "metadata" => metadata,
    }
    order["status"] = status if status
    { "company_id" => @company.fluid_company_id, "order" => order }
  end

  def run_with_captured_body(params)
    captured = nil
    post = lambda do |*args, **_kw|
      captured = JSON.parse((args[1] || {})[:body])
      FakeResponse.new({ "orderId" => 42 })
    end
    HTTParty.stub(:post, post) do
      FluidApi::V2::OrdersService.stub(:new, FakeOrdersService.new) do
        Shipstation::CreateOrder.new(params).call
      end
    end
    captured
  end

  # Runs #call and reports whether an HTTP POST to ShipStation was attempted.
  def run_tracking_http(params)
    posted = false
    HTTParty.stub(:post, ->(*_a, **_k) { posted = true; FakeResponse.new({ "orderId" => 42 }) }) do
      FluidApi::V2::OrdersService.stub(:new, FakeOrdersService.new) do
        Shipstation::CreateOrder.new(params).call
      end
    end
    posted
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

  # -- status gating / payment hold ----------------------------------------

  test "submits when status is awaiting_shipment" do
    posted = run_tracking_http(order_params(status: "awaiting_shipment"))
    _(posted).must_equal true
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "SUBMITTED"
  end

  test "submits when status is blank" do
    _(run_tracking_http(order_params)).must_equal true
  end

  test "holds an awaiting_payment order without sending" do
    posted = run_tracking_http(order_params(status: "awaiting_payment"))
    _(posted).must_equal false
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "AWAITING_PAYMENT"
  end

  test "skips an unfulfillable status without creating a record or sending" do
    posted = run_tracking_http(order_params(status: "cancelled"))
    _(posted).must_equal false
    _(@company.shipstation_orders.find_by(fluid_order_id: 555)).must_be_nil
  end

  test "does not resubmit an order already SUBMITTED" do
    @company.shipstation_orders.create!(fluid_order_id: 555, fluid_order_number: "ORD-555", status: "SUBMITTED")
    posted = run_tracking_http(order_params(status: "awaiting_shipment"))
    _(posted).must_equal false
  end

  test "releases a held order when it becomes fulfillable" do
    # First: held as awaiting_payment.
    run_tracking_http(order_params(status: "awaiting_payment"))
    held = @company.shipstation_orders.find_by(fluid_order_id: 555)
    _(held.status).must_equal "AWAITING_PAYMENT"

    # Then: order.updated arrives fulfillable -> submitted.
    posted = run_tracking_http(order_params(status: "awaiting_shipment"))
    _(posted).must_equal true
    _(held.reload.status).must_equal "SUBMITTED"
  end

  # -- batching hold --------------------------------------------------------

  test "holds a fulfillable order for batching (window sets hold_until)" do
    @company.integration_setting.update!(hold_for_batch: true, batch_window_minutes: 30)
    posted = run_tracking_http(order_params(status: "awaiting_shipment"))
    _(posted).must_equal false
    order = @company.shipstation_orders.find_by(fluid_order_id: 555)
    _(order.status).must_equal "HELD"
    _(order.hold_until).wont_be_nil
  end

  test "holds for batching with no window leaves hold_until nil (manual release)" do
    @company.integration_setting.update!(hold_for_batch: true, batch_window_minutes: nil)
    run_tracking_http(order_params(status: "awaiting_shipment"))
    order = @company.shipstation_orders.find_by(fluid_order_id: 555)
    _(order.status).must_equal "HELD"
    _(order.hold_until).must_be_nil
  end

  test "respect_hold false bypasses batching and submits immediately" do
    @company.integration_setting.update!(hold_for_batch: true, batch_window_minutes: 30)
    posted = false
    HTTParty.stub(:post, ->(*_a, **_k) { posted = true; FakeResponse.new({ "orderId" => 42 }) }) do
      FluidApi::V2::OrdersService.stub(:new, FakeOrdersService.new) do
        Shipstation::CreateOrder.new(order_params(status: "awaiting_shipment"), respect_hold: false).call
      end
    end
    _(posted).must_equal true
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "SUBMITTED"
  end

  test "awaiting_payment takes precedence over the batching hold" do
    @company.integration_setting.update!(hold_for_batch: true, batch_window_minutes: 30)
    run_tracking_http(order_params(status: "awaiting_payment"))
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "AWAITING_PAYMENT"
  end

  # -- hardening (review follow-ups) ---------------------------------------

  test "refreshes stored payload on reprocess so a paid held order ships" do
    @company.integration_setting.update!(hold_for_batch: true, batch_window_minutes: 30)
    # Held while awaiting payment.
    run_tracking_http(order_params(status: "awaiting_payment"))
    order = @company.shipstation_orders.find_by(fluid_order_id: 555)
    _(order.status).must_equal "AWAITING_PAYMENT"

    # order.updated arrives paid -> batch-held, payload refreshed.
    run_tracking_http(order_params(status: "awaiting_shipment"))
    order.reload
    _(order.status).must_equal "HELD"
    _(order.request_payload["status"]).must_equal "awaiting_shipment"

    # Release uses the refreshed payload and actually submits.
    posted = false
    HTTParty.stub(:post, ->(*_a, **_k) { posted = true; FakeResponse.new({ "orderId" => 42 }) }) do
      FluidApi::V2::OrdersService.stub(:new, FakeOrdersService.new) do
        payload = { "order" => order.request_payload, "company_id" => @company.fluid_company_id }
        Shipstation::CreateOrder.new(payload, respect_hold: false).call
      end
    end
    _(posted).must_equal true
    _(order.reload.status).must_equal "SUBMITTED"
  end

  test "a Fluid external-id sync failure does not fail or re-mark the order" do
    posted = 0
    HTTParty.stub(:post, ->(*_a, **_k) { posted += 1; FakeResponse.new({ "orderId" => 42 }) }) do
      FluidApi::V2::OrdersService.stub(:new, RaisingOrdersService.new) do
        Shipstation::CreateOrder.new(order_params(status: "awaiting_shipment")).call
      end
    end
    _(posted).must_equal 1
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "SUBMITTED"
  end

  test "marks an existing pre-submit order CANCELLED when Fluid reports it unfulfillable" do
    @company.integration_setting.update!(hold_for_batch: true, batch_window_minutes: 30)
    run_tracking_http(order_params(status: "awaiting_shipment")) # HELD
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "HELD"

    run_tracking_http(order_params(status: "cancelled"))
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "CANCELLED"
  end

  test "preserves the original hold_until across repeated updates" do
    @company.integration_setting.update!(hold_for_batch: true, batch_window_minutes: 30)
    run_tracking_http(order_params(status: "awaiting_shipment"))
    first = @company.shipstation_orders.find_by(fluid_order_id: 555).hold_until
    _(first).wont_be_nil

    run_tracking_http(order_params(status: "awaiting_shipment"))
    second = @company.shipstation_orders.find_by(fluid_order_id: 555).hold_until
    _(second.to_i).must_equal first.to_i
  end

  test "records the seen shipping method even when the order is held for batch" do
    @company.integration_setting.update!(hold_for_batch: true, batch_window_minutes: 30)
    run_tracking_http(order_params(status: "awaiting_shipment", metadata: { "shipping" => { "title" => "Overnight" } }))
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "HELD"
    _(@company.seen_shipping_methods.find_by(fluid_shipping_title: "Overnight")).wont_be_nil
  end

  # -- store assignment -----------------------------------------------------

  test "assigns the configured store via advancedOptions.storeId" do
    @company.integration_setting.update!(store_id: "3618888")
    body = run_with_captured_body(order_params)
    _(body["advancedOptions"]).must_equal({ "storeId" => 3618888 })
  end

  test "omits advancedOptions when no store is configured" do
    body = run_with_captured_body(order_params)
    _(body.key?("advancedOptions")).must_equal false
  end

  # -- carrier/service pairing + failure handling ---------------------------

  test "drops a carrier with no service and sends requestedShippingService only" do
    # A legacy/incomplete mapping (carrier, no service) that predates the model
    # validation — the service must degrade gracefully rather than push a carrier
    # ShipStation will reject.
    mapping = @company.shipping_method_mappings.build(
      fluid_shipping_title: "Ground Shipping",
      carrier_code: "fedex",
    )
    mapping.save!(validate: false)
    body = run_with_captured_body(
      order_params(metadata: { "shipping" => { "title" => "Ground Shipping" } }),
    )
    _(body["requestedShippingService"]).must_equal "Ground Shipping"
    _(body.key?("carrierCode")).must_equal false
    _(body.key?("serviceCode")).must_equal false
  end

  test "a 4xx rejection records FAILED with the real reason and does not raise" do
    result = nil
    HTTParty.stub(:post, ->(*_a, **_k) { FakeResponse.new({ "Message" => "Invalid serviceCode" }, 400) }) do
      FluidApi::V2::OrdersService.stub(:new, FakeOrdersService.new) do
        result = Shipstation::CreateOrder.new(order_params(status: "awaiting_shipment")).call
      end
    end
    _(result.success?).must_equal false
    order = @company.shipstation_orders.find_by(fluid_order_id: 555)
    _(order.status).must_equal "FAILED"
    _(order.last_error).must_equal "ShipStation 400: Invalid serviceCode"
    _(order.retry_count).must_equal 1
  end

  test "a 5xx failure raises so the job retries (transient, unlike a 4xx)" do
    error = assert_raises(RuntimeError) do
      HTTParty.stub(:post, ->(*_a, **_k) { FakeResponse.new({ "Message" => "server error" }, 500) }) do
        FluidApi::V2::OrdersService.stub(:new, FakeOrdersService.new) do
          Shipstation::CreateOrder.new(order_params(status: "awaiting_shipment")).call
        end
      end
    end
    _(error.message).must_include "ShipStation 500: server error"
  end

  # -- unfulfillable / cancellation -----------------------------------------

  test "cancels a submitted order in ShipStation when Fluid marks it unfulfillable" do
    @company.shipstation_orders.create!(
      fluid_order_id: 555, fluid_order_number: "ORD-555", status: "SUBMITTED", shipstation_order_id: "999",
    )
    Shipstation::CancelOrder.stub(:new, ->(*) { FakeCancel.new(:cancelled) }) do
      Shipstation::CreateOrder.new(order_params(status: "cancelled")).call
    end
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "CANCELLED"
  end

  test "does NOT cancel a submitted order that already has a label" do
    order = @company.shipstation_orders.create!(
      fluid_order_id: 555, fluid_order_number: "ORD-555", status: "SUBMITTED", shipstation_order_id: "999",
    )
    Shipstation::CancelOrder.stub(:new, ->(*) { FakeCancel.new(:skipped_has_label) }) do
      Shipstation::CreateOrder.new(order_params(status: "cancelled")).call
    end
    order.reload
    _(order.status).must_equal "SUBMITTED"
    _(order.last_error).must_include "already has a label"
  end

  test "marks a pre-submit order CANCELLED without calling ShipStation" do
    @company.shipstation_orders.create!(
      fluid_order_id: 555, fluid_order_number: "ORD-555", status: "HELD",
    )
    Shipstation::CancelOrder.stub(:new, ->(*) { raise "should not call ShipStation" }) do
      Shipstation::CreateOrder.new(order_params(status: "cancelled")).call
    end
    _(@company.shipstation_orders.find_by(fluid_order_id: 555).status).must_equal "CANCELLED"
  end

  test "never recalls an already-SHIPPED order" do
    order = @company.shipstation_orders.create!(
      fluid_order_id: 555, fluid_order_number: "ORD-555", status: "SHIPPED", shipstation_order_id: "999",
    )
    Shipstation::CancelOrder.stub(:new, ->(*) { raise "should not call ShipStation" }) do
      Shipstation::CreateOrder.new(order_params(status: "cancelled")).call
    end
    _(order.reload.status).must_equal "SHIPPED"
  end
end
