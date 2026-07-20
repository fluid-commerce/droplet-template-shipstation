class WebhookController < ApplicationController
  skip_before_action :verify_authenticity_token
  before_action :validate_droplet_authorization, if: :is_installed_event?, only: :create
  before_action :authenticate_webhook_token, unless: :is_installed_event?, only: :create
  before_action :authenticate_shipped_webhook, only: :shipped

  def create
    event_type = "#{effective_payload["resource"]}.#{effective_payload["event"]}"
    version = effective_payload["version"]

    if EventHandler.route(event_type, effective_payload, version: version)
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

    # Validate resource_url points to ShipStation to prevent SSRF
    unless valid_shipstation_url?(resource_url)
      Rails.logger.warn("[ShipStation Webhook] Invalid resource_url: #{resource_url}")
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

  ALLOWED_SHIPSTATION_HOSTS = %w[ssapi.shipstation.com ssapi6.shipstation.com].freeze

  def valid_shipstation_url?(url)
    uri = URI.parse(url)
    uri.scheme == "https" && ALLOWED_SHIPSTATION_HOSTS.include?(uri.host)
  rescue URI::InvalidURIError
    false
  end

  def is_installed_event?
    effective_payload["resource"] == "droplet" && effective_payload["event"] == "installed"
  end

  # Overrides ApplicationController#validate_droplet_authorization to read the
  # droplet uuid from the (possibly enveloped) webhook payload rather than
  # top-level params.
  def validate_droplet_authorization
    return if effective_payload.dig("company", "droplet_uuid") == Setting.droplet.uuid

    render json: { error: "Unauthorized" }, status: :unauthorized
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

    # Fluid registers each company's webhooks with that company's
    # webhook_verification_token, so incoming per-company webhooks (e.g.
    # order.created) carry it. Accept it in addition to the legacy global
    # tokens (Setting/ENV) for backward compatibility.
    candidate_tokens = [
      find_company&.webhook_verification_token,
      Setting.fluid_webhook.auth_token,
      ENV["FLUID_WEBHOOK_AUTH_TOKEN"],
    ].compact_blank

    candidate_tokens.any? { |token| ActiveSupport::SecurityUtils.secure_compare(auth_header, token) }
  end

  def find_company
    fluid_company_id = effective_payload["company_id"] || effective_payload.dig("company", "fluid_company_id")
    Company.find_by(fluid_company_id: fluid_company_id)
  end

  # Fluid delivers webhooks either flat or wrapped in a "payload" envelope.
  # Normalize to the inner content so resource/event/company reads work
  # regardless of shape:
  #   Flat:   { "resource" => "droplet", "event" => "installed", "company" => {...} }
  #   Nested: { "name" => "...", "payload" => { "resource" => "...", "company" => {...} } }
  def effective_payload
    @effective_payload ||= begin
      inner = raw_webhook_body["payload"]
      inner.is_a?(Hash) && inner["resource"].present? ? inner : raw_webhook_body
    end
  end

  # Parse the raw JSON request body. We read the body instead of params to get
  # the full webhook envelope before normalization.
  def raw_webhook_body
    @raw_webhook_body ||= begin
      body = request.raw_post
      if body.blank?
        {}
      else
        parsed = JSON.parse(body)
        parsed.is_a?(Hash) ? parsed : {}
      end
    rescue JSON::ParserError
      # Fall back to permitted params for form-encoded webhooks
      params.permit(
        :resource, :event, :version, :company_id,
        company: {}, payload: {}
      ).to_h.deep_stringify_keys
    end
  end
end
