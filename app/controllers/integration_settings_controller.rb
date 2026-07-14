class IntegrationSettingsController < ApplicationController
  skip_before_action :verify_authenticity_token
  before_action :authenticate_request

  def create
    integration_setting = IntegrationSetting.find_or_initialize_by(company_id: integration_setting_params[:company_id])

    integration_setting.settings = {
      api_key: integration_setting_params[:api_key],
      api_secret: integration_setting_params[:api_secret],
    }

    integration_setting.save!

    render json: integration_setting, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { errors: e.record.errors.full_messages }, status: :unprocessable_entity
  end

private

  def authenticate_request
    return if valid_internal_token?

    render json: { error: "Unauthorized" }, status: :unauthorized
  end

  def valid_internal_token?
    auth_header = request.headers["Authorization"]
    return false if auth_header.blank?

    token = auth_header.remove("Bearer ").strip
    expected = ENV["INTERNAL_API_TOKEN"]
    expected.present? && ActiveSupport::SecurityUtils.secure_compare(token, expected)
  end

  def integration_setting_params
    params.require(:integration_setting).permit(:company_id, :api_key, :api_secret)
  end
end
