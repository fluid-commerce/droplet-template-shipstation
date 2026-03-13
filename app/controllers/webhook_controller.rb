class WebhookController < ApplicationController
  skip_before_action :verify_authenticity_token
  before_action :validate_droplet_authorization, if: :is_installed_event?, only: :create
  before_action :authenticate_webhook_token, unless: :is_installed_event?, only: :create
  before_action :authenticate_shipped_webhook, only: :shipped

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

  def shipped
    Rails.logger.info("[ShipStation Webhook] Shipped webhook received")

    resource_url = params[:resource_url]
    company_id = params[:company_id]

    unless resource_url.present? && company_id.present?
      Rails.logger.warn("[ShipStation Webhook] Missing resource_url or company_id")
      head :bad_request
      return
    end

    # Route through EventHandler so it gets retry logic from WebhookEventJob
    payload = { "resource_url" => resource_url, "company_id" => company_id }
    company = Company.find_by(fluid_company_id: company_id) || Company.find(company_id)

    if company
      # Include company info so WebhookEventJob can find it
      payload["company"] = {
        "company_droplet_uuid" => company.company_droplet_uuid,
        "fluid_company_id" => company.fluid_company_id,
      }
    end

    OrderShippedJob.perform_later(payload)
    head :accepted
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

  def authenticate_shipped_webhook
    return if valid_auth_token?

    render json: { error: "Unauthorized" }, status: :unauthorized
  end

  def valid_auth_token?
    auth_header = request.headers["AUTH_TOKEN"] || request.headers["X-Auth-Token"] || request.env["HTTP_AUTH_TOKEN"]
    return false if auth_header.blank?

    webhook_auth_token = Setting.fluid_webhook.auth_token
    env_token = ENV["FLUID_WEBHOOK_AUTH_TOKEN"]

    auth_header == webhook_auth_token || (env_token.present? && auth_header == env_token)
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
