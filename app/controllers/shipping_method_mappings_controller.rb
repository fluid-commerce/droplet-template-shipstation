# frozen_string_literal: true

# CRUD for the embedded droplet UI's Shipping Methods tab. DRI-authenticated and
# scoped to the current company, mirroring IntegrationSettingsController.
class ShippingMethodMappingsController < ApplicationController
  include DriAuthenticatable

  skip_before_action :verify_authenticity_token
  before_action :require_xhr
  before_action :authenticate_dri

  # Returns the configured mappings plus the seen-but-unmapped titles so the UI
  # can prompt the admin to map methods it has actually observed on orders.
  def index
    mappings = current_company.shipping_method_mappings.order(:fluid_shipping_title)
    mapped_titles = mappings.map { |m| m.fluid_shipping_title.downcase }
    unmapped = current_company.seen_shipping_methods
      .reject { |s| mapped_titles.include?(s.fluid_shipping_title.downcase) }
      .sort_by { |s| -s.seen_count }

    render json: {
      mappings: mappings.map { |m| mapping_json(m) },
      unmapped: unmapped.map { |s| seen_json(s) },
    }
  end

  # Upserts a mapping keyed by fluid_shipping_title (case-insensitive per company).
  def create
    title = mapping_params[:fluid_shipping_title].to_s.strip
    if title.blank?
      return render json: { errors: [ "Shipping method title is required" ] }, status: :unprocessable_entity
    end

    mapping = current_company.shipping_method_mappings
      .find_or_initialize_by(fluid_shipping_title: title)
    mapping.assign_attributes(mapping_params.except(:fluid_shipping_title))
    mapping.save!

    render json: mapping_json(mapping), status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { errors: e.record.errors.full_messages }, status: :unprocessable_entity
  end

  def destroy
    mapping = current_company.shipping_method_mappings.find_by(id: params[:id])
    return render json: { error: "Not found" }, status: :not_found unless mapping

    mapping.destroy!
    head :no_content
  end

private

  def require_xhr
    return if request.headers["X-Requested-With"] == "XMLHttpRequest"

    render json: { error: "Unauthorized" }, status: :unauthorized
  end

  def mapping_params
    params.require(:shipping_method_mapping)
      .permit(:fluid_shipping_title, :carrier_code, :service_code, :package_code, :description)
  end

  def mapping_json(mapping)
    {
      id: mapping.id,
      fluid_shipping_title: mapping.fluid_shipping_title,
      carrier_code: mapping.carrier_code,
      service_code: mapping.service_code,
      package_code: mapping.package_code,
      description: mapping.description,
    }
  end

  def seen_json(seen)
    {
      fluid_shipping_title: seen.fluid_shipping_title,
      seen_count: seen.seen_count,
      last_seen_at: seen.last_seen_at,
      example_order_number: seen.example_order_number,
    }
  end
end
