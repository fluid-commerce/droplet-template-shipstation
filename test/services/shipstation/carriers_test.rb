require "test_helper"

class Shipstation::CarriersTest < ActiveSupport::TestCase
  fixtures :companies

  setup do
    @company = companies(:acme)
    @company.create_integration_setting!(settings: { "api_key" => "k", "api_secret" => "s" })
  end

  def ok(body)
    OpenStruct.new(code: 200, body: body.to_json)
  end

  test "returns the carriers array on success" do
    HTTParty.stub(:get, ok([ { "code" => "fedex", "name" => "FedEx" } ])) do
      result = Shipstation::Carriers.new(@company.id).carriers
      _(result.first["code"]).must_equal "fedex"
    end
  end

  test "returns [] when credentials are missing" do
    @company.integration_setting.update!(settings: {})
    _(Shipstation::Carriers.new(@company.id).carriers).must_equal []
  end

  test "returns [] on a non-200 response" do
    HTTParty.stub(:get, OpenStruct.new(code: 401, body: "nope")) do
      _(Shipstation::Carriers.new(@company.id).carriers).must_equal []
    end
  end

  test "returns [] when the request raises" do
    HTTParty.stub(:get, ->(*_a, **_k) { raise "boom" }) do
      _(Shipstation::Carriers.new(@company.id).carriers).must_equal []
    end
  end

  test "returns [] for services without a carrier code" do
    _(Shipstation::Carriers.new(@company.id).services("")).must_equal []
  end

  test "passes the carrier code when listing services" do
    captured = nil
    HTTParty.stub(:get, ->(*_a, **kw) { captured = kw[:query]; ok([ { "code" => "fedex_2day" } ]) }) do
      Shipstation::Carriers.new(@company.id).services("fedex")
    end
    _(captured[:carrierCode]).must_equal "fedex"
  end
end
