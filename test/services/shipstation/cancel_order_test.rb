require "test_helper"

class Shipstation::CancelOrderTest < ActiveSupport::TestCase
  fixtures :companies

  setup do
    @company = companies(:acme)
    @company.create_integration_setting!(settings: { "api_key" => "k", "api_secret" => "s" })
  end

  def order_response(status)
    OpenStruct.new(code: 200, body: { "orderId" => 999, "orderStatus" => status }.to_json)
  end

  test "cancels an order that has not shipped" do
    deleted = false
    HTTParty.stub(:get, order_response("awaiting_shipment")) do
      HTTParty.stub(:delete, ->(*_a, **_k) { deleted = true; OpenStruct.new(code: 200, body: "{}") }) do
        _(Shipstation::CancelOrder.new(@company.id).call("999")).must_equal :cancelled
      end
    end
    _(deleted).must_equal true
  end

  test "never cancels an order that already shipped (has a label)" do
    deleted = false
    HTTParty.stub(:get, order_response("shipped")) do
      HTTParty.stub(:delete, ->(*_a, **_k) { deleted = true; OpenStruct.new(code: 200, body: "{}") }) do
        _(Shipstation::CancelOrder.new(@company.id).call("999")).must_equal :skipped_has_label
      end
    end
    _(deleted).must_equal false
  end

  test "reports an already-cancelled order without deleting" do
    HTTParty.stub(:get, order_response("cancelled")) do
      _(Shipstation::CancelOrder.new(@company.id).call("999")).must_equal :already_cancelled
    end
  end

  test "returns not_found on a 404" do
    HTTParty.stub(:get, OpenStruct.new(code: 404, body: "not found")) do
      _(Shipstation::CancelOrder.new(@company.id).call("999")).must_equal :not_found
    end
  end

  test "returns not_found when credentials are missing" do
    @company.integration_setting.update!(settings: {})
    _(Shipstation::CancelOrder.new(@company.id).call("999")).must_equal :not_found
  end

  test "raises when the delete fails so the job can retry" do
    HTTParty.stub(:get, order_response("awaiting_shipment")) do
      HTTParty.stub(:delete, OpenStruct.new(code: 500, body: "err")) do
        assert_raises(RuntimeError) { Shipstation::CancelOrder.new(@company.id).call("999") }
      end
    end
  end
end
