class HomeController < ApplicationController
  def index
    @dri = params[:dri]
    company = Company.active.find_by(droplet_installation_uuid: @dri) if @dri.present?
    @integration_settings = company&.integration_setting
  end
end
