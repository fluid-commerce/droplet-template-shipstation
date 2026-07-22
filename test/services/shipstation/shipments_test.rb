require "test_helper"

class Shipstation::ShipmentsTest < ActiveSupport::TestCase
  fixtures :companies

  setup do
    @company = companies(:acme)
    @company.create_integration_setting!(settings: { "api_key" => "k", "api_secret" => "s" })
  end

  def ok(shipments)
    OpenStruct.new(code: 200, body: { "shipments" => shipments }.to_json)
  end

  def all_for(order_id = "372209473")
    Shipstation::Shipments.new(@company.id).all_for_order(order_id)
  end

  test "returns every non-voided shipment carrying a tracking number" do
    shipments = [
      { "trackingNumber" => nil, "voided" => false },
      { "trackingNumber" => "VOIDED1", "voided" => true },
      { "trackingNumber" => "TRK1", "carrierCode" => "fedex", "voided" => false },
      { "trackingNumber" => "TRK2", "carrierCode" => "fedex", "voided" => false },
    ]
    HTTParty.stub(:get, ok(shipments)) do
      _(all_for.map { |s| s["trackingNumber"] }).must_equal %w[TRK1 TRK2]
    end
  end

  test "queries ShipStation by orderId" do
    captured = nil
    HTTParty.stub(:get, ->(*_a, **kw) { captured = kw[:query]; ok([]) }) do
      all_for
    end
    _(captured[:orderId]).must_equal "372209473"
  end

  test "returns [] when no shipment has tracking yet" do
    HTTParty.stub(:get, ok([ { "trackingNumber" => nil, "voided" => false } ])) do
      _(all_for).must_equal []
    end
  end

  test "returns [] without a ShipStation order id" do
    _(all_for(nil)).must_equal []
  end

  test "returns [] when credentials are missing" do
    @company.integration_setting.update!(settings: {})
    _(all_for).must_equal []
  end

  test "returns [] on a non-200 response" do
    HTTParty.stub(:get, OpenStruct.new(code: 500, body: "err")) do
      _(all_for).must_equal []
    end
  end

  test "returns [] when the request raises" do
    HTTParty.stub(:get, ->(*_a, **_k) { raise "boom" }) do
      _(all_for).must_equal []
    end
  end
end
