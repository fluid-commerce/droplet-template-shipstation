class IntegrationSettingsController < ApplicationController
  skip_before_action :verify_authenticity_token

  def create
    integration_setting = IntegrationSetting.find_or_initialize_by(company_id: integration_setting_params[:company_id])

    integration_setting.settings = {
      api_base_url: integration_setting_params[:api_base_url],
      api_key: integration_setting_params[:api_key],
      api_secret: integration_setting_params[:api_secret],
      fluid_api_token: integration_setting_params[:fluid_api_token]
    }

    integration_setting.save!

    render json: integration_setting, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { errors: e.record.errors.full_messages }, status: :unprocessable_entity
  end

  private

  def integration_setting_params
    params.require(:integration_setting).permit(:company_id, :api_base_url, :api_key, :api_secret, :fluid_api_token)
  end
end
