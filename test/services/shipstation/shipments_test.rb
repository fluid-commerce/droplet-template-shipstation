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

  test "waits out a 429 and retries" do
    calls = 0
    get = lambda do |*_a, **_k|
      calls += 1
      if calls == 1
        OpenStruct.new(code: 429, headers: { "Retry-After" => "1" }, body: "")
      else
        ok([ { "trackingNumber" => "T1", "voided" => false } ])
      end
    end
    svc = Shipstation::Shipments.new(@company.id)
    svc.stub(:pause, nil) do
      HTTParty.stub(:get, get) do
        _(svc.all_for_order("999").map { |s| s["trackingNumber"] }).must_equal [ "T1" ]
      end
    end
    _(calls).must_equal 2
  end

  test "raises RateLimitError when 429 persists" do
    svc = Shipstation::Shipments.new(@company.id)
    svc.stub(:pause, nil) do
      HTTParty.stub(:get, OpenStruct.new(code: 429, headers: {}, body: "")) do
        assert_raises(Shipstation::RateLimitError) { svc.all_for_order("999") }
      end
    end
  end

  test "walks every result page" do
    get = lambda do |*_a, **kw|
      page = kw[:query][:page]
      shipments = [ { "trackingNumber" => "T#{page}", "voided" => false } ]
      OpenStruct.new(code: 200, body: { "shipments" => shipments, "pages" => 2 }.to_json)
    end
    HTTParty.stub(:get, get) do
      _(all_for.map { |s| s["trackingNumber"] }).must_equal %w[T1 T2]
    end
  end
end
