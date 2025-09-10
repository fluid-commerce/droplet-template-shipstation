class WebhooksController < ApplicationController
  skip_before_action :verify_authenticity_token
  before_action :validate_droplet_authorization, if: :is_installed_event?
  before_action :authenticate_webhook_token, unless: :is_installed_event?

  def create
    event_type = "#{params[:resource]}.#{params[:event]}"
    version = params[:version]

    payload = params.to_unsafe_h.deep_dup

    if EventHandler.route(event_type, payload, version: version)
      # A 202 Accepted indicates that we have accepted the webhook and queued
      # the appropriate background job for processing.
      head :accepted
    else
      head :no_content
    end
  end

private

  def is_installed_event?
    params[:resource] == "droplet" && params[:event] == "installed"
  end

  def authenticate_webhook_token
    company = find_company
    if company.blank?
      render json: { error: "Company not found" }, status: :not_found
    elsif !valid_auth_token?
      render json: { error: "Unauthorized" }, status: :unauthorized
    end
  end

  def valid_auth_token?
    # Check header auth token first, then fall back to params
    auth_header = request.headers["AUTH_TOKEN"] || request.headers["X-Auth-Token"] || request.env["HTTP_AUTH_TOKEN"]
    webhook_auth_token = Setting.fluid_webhook.auth_token

    (auth_header.present? && auth_header == webhook_auth_token) || auth_header == ENV["FLUID_WEBHOOK_AUTH_TOKEN"]
  end

  def find_company
    fluid_company_id = params[:company_id] || company_params[:fluid_company_id]
    Company.find_by(fluid_company_id: fluid_company_id)
  end

  def company_params
    params.require(:company).permit(
      :company_droplet_uuid,
      :droplet_installation_uuid,
      :fluid_company_id,
      :webhook_verification_token,
      :authentication_token
    )
  end
end
