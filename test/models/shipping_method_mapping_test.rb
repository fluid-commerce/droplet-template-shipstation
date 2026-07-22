require "test_helper"

describe ShippingMethodMapping do
  fixtures(:companies)

  let(:company) { companies(:acme) }

  it "requires a fluid_shipping_title" do
    mapping = ShippingMethodMapping.new(company: company)
    _(mapping).wont_be :valid?
    _(mapping.errors[:fluid_shipping_title]).must_include "can't be blank"
  end

  it "enforces uniqueness of title per company (case-insensitive)" do
    company.shipping_method_mappings.create!(fluid_shipping_title: "Ground Shipping")
    dup = company.shipping_method_mappings.new(fluid_shipping_title: "ground shipping")
    _(dup).wont_be :valid?
  end

  it "allows the same title for different companies" do
    companies(:acme).shipping_method_mappings.create!(fluid_shipping_title: "Ground Shipping")
    other = companies(:globex).shipping_method_mappings.new(fluid_shipping_title: "Ground Shipping")
    _(other).must_be :valid?
  end

  it "rejects a carrier_code with no service_code (ShipStation requires both)" do
    mapping = company.shipping_method_mappings.new(
      fluid_shipping_title: "Ground Shipping",
      carrier_code: "fedex",
    )
    _(mapping).wont_be :valid?
    _(mapping.errors[:service_code]).must_include "can't be blank"
  end

  it "allows a carrier_code when a service_code is also set" do
    mapping = company.shipping_method_mappings.new(
      fluid_shipping_title: "Ground Shipping",
      carrier_code: "fedex",
      service_code: "fedex_2day",
    )
    _(mapping).must_be :valid?
  end

  it "allows a title with no codes at all" do
    _(company.shipping_method_mappings.new(fluid_shipping_title: "Ground Shipping")).must_be :valid?
  end

  describe "#any_code?" do
    it "is false with no codes" do
      _(ShippingMethodMapping.new.any_code?).must_equal false
    end

    it "is true when any code is present" do
      _(ShippingMethodMapping.new(service_code: "usps_priority_mail").any_code?).must_equal true
    end
  end
end
