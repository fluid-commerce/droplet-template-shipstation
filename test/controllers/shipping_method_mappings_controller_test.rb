require "test_helper"

describe ShippingMethodMappingsController do
  fixtures(:companies)

  let(:company) { companies(:acme) }
  let(:dri) { company.droplet_installation_uuid }
  let(:xhr_headers) { { "X-Requested-With" => "XMLHttpRequest" } }

  it "rejects requests without the XHR header" do
    get shipping_method_mappings_url(dri: dri)
    must_respond_with :unauthorized
  end

  it "rejects requests with an unknown dri" do
    get shipping_method_mappings_url(dri: "nope"), headers: xhr_headers
    must_respond_with :unauthorized
  end

  it "lists mappings and seen-but-unmapped titles scoped to the company" do
    company.shipping_method_mappings.create!(fluid_shipping_title: "Ground", service_code: "s")
    company.seen_shipping_methods.create!(
      fluid_shipping_title: "Express", seen_count: 3, last_seen_at: Time.current,
    )
    get shipping_method_mappings_url(dri: dri), headers: xhr_headers
    must_respond_with :success
    body = JSON.parse(response.body)
    _(body["mappings"].map { |m| m["fluid_shipping_title"] }).must_include "Ground"
    _(body["unmapped"].map { |u| u["fluid_shipping_title"] }).must_include "Express"
  end

  it "omits already-mapped titles from unmapped" do
    company.shipping_method_mappings.create!(fluid_shipping_title: "Ground")
    company.seen_shipping_methods.create!(
      fluid_shipping_title: "ground", seen_count: 1, last_seen_at: Time.current,
    )
    get shipping_method_mappings_url(dri: dri), headers: xhr_headers
    body = JSON.parse(response.body)
    _(body["unmapped"]).must_be_empty
  end

  it "creates a mapping" do
    post shipping_method_mappings_url,
      params: { dri: dri, shipping_method_mapping: { fluid_shipping_title: "Ground", carrier_code: "ups" } },
      headers: xhr_headers
    must_respond_with :created
    _(company.shipping_method_mappings.find_by(fluid_shipping_title: "Ground").carrier_code).must_equal "ups"
  end

  it "upserts an existing mapping by title" do
    company.shipping_method_mappings.create!(fluid_shipping_title: "Ground", carrier_code: "ups")
    post shipping_method_mappings_url,
      params: { dri: dri, shipping_method_mapping: { fluid_shipping_title: "Ground", carrier_code: "fedex" } },
      headers: xhr_headers
    must_respond_with :created
    _(company.shipping_method_mappings.where(fluid_shipping_title: "Ground").count).must_equal 1
    _(company.shipping_method_mappings.find_by(fluid_shipping_title: "Ground").carrier_code).must_equal "fedex"
  end

  it "rejects a blank title" do
    post shipping_method_mappings_url,
      params: { dri: dri, shipping_method_mapping: { fluid_shipping_title: "  " } },
      headers: xhr_headers
    must_respond_with :unprocessable_entity
  end

  it "destroys a mapping" do
    mapping = company.shipping_method_mappings.create!(fluid_shipping_title: "Ground")
    delete shipping_method_mapping_url(mapping, dri: dri), headers: xhr_headers
    must_respond_with :no_content
    _(company.shipping_method_mappings.exists?(mapping.id)).must_equal false
  end

  it "does not destroy another company's mapping" do
    other = companies(:globex).shipping_method_mappings.create!(fluid_shipping_title: "Ground")
    delete shipping_method_mapping_url(other, dri: dri), headers: xhr_headers
    must_respond_with :not_found
    _(ShippingMethodMapping.exists?(other.id)).must_equal true
  end
end
