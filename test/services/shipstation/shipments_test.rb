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

  test "returns the first non-voided shipment carrying a tracking number" do
    shipments = [
      { "trackingNumber" => nil, "voided" => false },
      { "trackingNumber" => "VOIDED1", "voided" => true },
      { "trackingNumber" => "382763123186", "carrierCode" => "fedex", "voided" => false },
    ]
    HTTParty.stub(:get, ok(shipments)) do
      result = Shipstation::Shipments.new(@company.id).latest_for_order("372209473")
      _(result["trackingNumber"]).must_equal "382763123186"
    end
  end

  test "queries ShipStation by orderId" do
    captured = nil
    HTTParty.stub(:get, ->(*_a, **kw) { captured = kw[:query]; ok([]) }) do
      Shipstation::Shipments.new(@company.id).latest_for_order("372209473")
    end
    _(captured[:orderId]).must_equal "372209473"
  end

  test "returns nil when no shipment has tracking yet" do
    HTTParty.stub(:get, ok([ { "trackingNumber" => nil, "voided" => false } ])) do
      _(Shipstation::Shipments.new(@company.id).latest_for_order("372209473")).must_be_nil
    end
  end

  test "returns nil without a ShipStation order id" do
    _(Shipstation::Shipments.new(@company.id).latest_for_order(nil)).must_be_nil
  end

  test "returns nil when credentials are missing" do
    @company.integration_setting.update!(settings: {})
    _(Shipstation::Shipments.new(@company.id).latest_for_order("372209473")).must_be_nil
  end

  test "returns nil on a non-200 response" do
    HTTParty.stub(:get, OpenStruct.new(code: 500, body: "err")) do
      _(Shipstation::Shipments.new(@company.id).latest_for_order("372209473")).must_be_nil
    end
  end

  test "returns nil when the request raises" do
    HTTParty.stub(:get, ->(*_a, **_k) { raise "boom" }) do
      _(Shipstation::Shipments.new(@company.id).latest_for_order("372209473")).must_be_nil
    end
  end
end
