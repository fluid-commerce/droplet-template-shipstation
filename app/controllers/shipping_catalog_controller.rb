# frozen_string_literal: true

# Backend proxy that feeds the Shipping Methods tab dropdowns. Keeps ShipStation
# credentials and the Fluid token server-side (never exposed to the browser).
# DRI-authenticated and scoped to the current company, like the other embedded
# endpoints.
class ShippingCatalogController < ApplicationController
  include DriAuthenticatable

  skip_before_action :verify_authenticity_token
  before_action :require_xhr
  before_action :authenticate_dri

  def carriers
    data = Shipstation::Carriers.new(current_company.id).carriers
    render json: { carriers: data.map { |c| code_name(c, fallback_name: c["nickname"]) } }
  end

  def services
    data = Shipstation::Carriers.new(current_company.id).services(params[:carrier_code])
    render json: { services: data.map { |s| code_name(s) } }
  end

  def packages
    data = Shipstation::Carriers.new(current_company.id).packages(params[:carrier_code])
    render json: { packages: data.map { |p| code_name(p) } }
  end

  # ShipStation stores an order can be assigned to (advancedOptions.storeId).
  def stores
    data = Shipstation::Carriers.new(current_company.id).stores
    render json: { stores: data.map { |s| store_json(s) } }
  end

  # Fluid shipping method titles: the configured methods from Fluid merged with
  # the titles actually seen on orders (which cover strategies the API omits).
  def fluid_methods
    api_names = FluidApi::V2::ShippingMethodsService.new(current_company.authentication_token).names
    seen = current_company.seen_shipping_methods.pluck(:fluid_shipping_title)
    render json: { titles: (api_names + seen).map(&:to_s).reject(&:blank?).uniq.sort }
  end

private

  def require_xhr
    return if request.headers["X-Requested-With"] == "XMLHttpRequest"

    render json: { error: "Unauthorized" }, status: :unauthorized
  end

  def code_name(hash, fallback_name: nil)
    { code: hash["code"], name: hash["name"].presence || fallback_name || hash["code"] }
  end

  def store_json(store)
    {
      id: store["storeId"].to_s,
      name: store["storeName"].presence || "Store #{store['storeId']}",
      marketplace: store["marketplaceName"],
    }
  end
end
