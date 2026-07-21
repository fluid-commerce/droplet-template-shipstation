require "test_helper"

describe FluidApi::V2::ShippingMethodsService do
  def resp(body, code: 200)
    OpenStruct.new(code: code, body: body.to_json)
  end

  it "extracts names from a wrapped collection" do
    HTTParty.stub(:get, resp({ "shipping_methods" => [ { "name" => "Ground" }, { "name" => "Express" } ] })) do
      _(FluidApi::V2::ShippingMethodsService.new("dit_x").names).must_equal %w[Ground Express]
    end
  end

  it "extracts names from a data envelope" do
    HTTParty.stub(:get, resp({ "data" => [ { "name" => "Ground" } ] })) do
      _(FluidApi::V2::ShippingMethodsService.new("dit_x").names).must_equal %w[Ground]
    end
  end

  it "extracts names from a bare array" do
    HTTParty.stub(:get, resp([ { "name" => "Ground" } ])) do
      _(FluidApi::V2::ShippingMethodsService.new("dit_x").names).must_equal %w[Ground]
    end
  end

  it "dedups and drops blank names" do
    body = { "shipping_methods" => [ { "name" => "Ground" }, { "name" => "Ground" }, { "name" => "" } ] }
    HTTParty.stub(:get, resp(body)) do
      _(FluidApi::V2::ShippingMethodsService.new("dit_x").names).must_equal %w[Ground]
    end
  end

  it "returns [] on a non-2xx response" do
    HTTParty.stub(:get, resp({}, code: 403)) do
      _(FluidApi::V2::ShippingMethodsService.new("dit_x").names).must_equal []
    end
  end

  it "returns [] when the request raises" do
    HTTParty.stub(:get, ->(*_a, **_k) { raise "boom" }) do
      _(FluidApi::V2::ShippingMethodsService.new("dit_x").names).must_equal []
    end
  end
end
