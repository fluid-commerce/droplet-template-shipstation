class IntegrationSettingsController < ApplicationController
  include DriAuthenticatable

  skip_before_action :verify_authenticity_token
  before_action :require_xhr
  before_action :authenticate_dri

  def create
    integration_setting = current_company.integration_setting ||
      current_company.build_integration_setting

    integration_setting.settings = {
      api_key: integration_setting_params[:api_key],
      api_secret: integration_setting_params[:api_secret],
      v2_api_key: integration_setting_params[:v2_api_key],
    }
    apply_batching_settings(integration_setting)
    apply_api_version(integration_setting)

    integration_setting.save!

    render json: { id: integration_setting.id }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { errors: e.record.errors.full_messages }, status: :unprocessable_entity
  end

  def test_connection
    connected = Shipstation::TestConnection.new(current_company.id).call

    render json: { connection: connected }
  end

  def test_v2_connection
    result = Shipstation::V2::TestConnection.new(current_company.id).call

    render json: result
  end

private

  # Defense against CSRF/cross-origin form posts now that Rails token
  # verification is skipped: browsers only allow this header on same-origin
  # scripted (fetch/XHR) requests, so a cross-site form cannot forge it.
  def require_xhr
    return if request.headers["X-Requested-With"] == "XMLHttpRequest"

    render json: { error: "Unauthorized" }, status: :unauthorized
  end

  # Persists batching config only when the client sent those fields, so a
  # credentials-only save doesn't reset a company's batching preferences.
  def apply_batching_settings(integration_setting)
    if integration_setting_params.key?(:hold_for_batch)
      integration_setting.hold_for_batch =
        ActiveModel::Type::Boolean.new.cast(integration_setting_params[:hold_for_batch])
    end

    if integration_setting_params.key?(:batch_window_minutes)
      value = integration_setting_params[:batch_window_minutes].presence
      integration_setting.batch_window_minutes = value && value.to_i
    end
  end

  # Only touch api_version when the client sent it (guards a partial save).
  def apply_api_version(integration_setting)
    return unless integration_setting_params.key?(:api_version)

    integration_setting.api_version = integration_setting_params[:api_version]
  end

  def integration_setting_params
    params.require(:integration_setting)
      .permit(:api_key, :api_secret, :v2_api_key, :api_version, :hold_for_batch, :batch_window_minutes)
  end
end
