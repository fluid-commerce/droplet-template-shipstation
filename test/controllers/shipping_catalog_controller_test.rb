require "test_helper"

# Fakes for the proxied services so the controller tests don't hit the network.
class FakeCarriers
  def carriers
    [ { "code" => "fedex", "name" => "FedEx" }, { "code" => "ups", "name" => nil, "nickname" => "UPS Acct" } ]
  end

  def services(_carrier_code)
    [ { "code" => "fedex_2day", "name" => "FedEx 2Day" } ]
  end

  def packages(_carrier_code)
    [ { "code" => "package", "name" => "Package" } ]
  end
end

class FakeFluidMethods
  def names
    [ "Ground Shipping", "Express" ]
  end
end

describe ShippingCatalogController do
  fixtures(:companies)

  let(:company) { companies(:acme) }
  let(:dri) { company.droplet_installation_uuid }
  let(:xhr) { { "X-Requested-With" => "XMLHttpRequest" } }

  it "requires the XHR header" do
    get shipping_catalog_carriers_url(dri: dri)
    must_respond_with :unauthorized
  end

  it "returns carriers as code/name, falling back to nickname" do
    Shipstation::Carriers.stub(:new, FakeCarriers.new) do
      get shipping_catalog_carriers_url(dri: dri), headers: xhr
    end
    must_respond_with :success
    carriers = JSON.parse(response.body)["carriers"]
    _(carriers[0]).must_equal({ "code" => "fedex", "name" => "FedEx" })
    _(carriers[1]).must_equal({ "code" => "ups", "name" => "UPS Acct" })
  end

  it "returns services for a carrier" do
    Shipstation::Carriers.stub(:new, FakeCarriers.new) do
      get shipping_catalog_services_url(dri: dri, carrier_code: "fedex"), headers: xhr
    end
    must_respond_with :success
    _(JSON.parse(response.body)["services"]).must_equal [ { "code" => "fedex_2day", "name" => "FedEx 2Day" } ]
  end

  it "merges Fluid API method names with seen titles, sorted and deduped" do
    company.seen_shipping_methods.create!(
      fluid_shipping_title: "Overnight", seen_count: 1, last_seen_at: Time.current,
    )
    company.seen_shipping_methods.create!(
      fluid_shipping_title: "Ground Shipping", seen_count: 1, last_seen_at: Time.current,
    )
    FluidApi::V2::ShippingMethodsService.stub(:new, FakeFluidMethods.new) do
      get shipping_catalog_fluid_methods_url(dri: dri), headers: xhr
    end
    must_respond_with :success
    _(JSON.parse(response.body)["titles"]).must_equal [ "Express", "Ground Shipping", "Overnight" ]
  end

  it "rejects an unknown dri" do
    get shipping_catalog_carriers_url(dri: "nope"), headers: xhr
    must_respond_with :unauthorized
  end
end
