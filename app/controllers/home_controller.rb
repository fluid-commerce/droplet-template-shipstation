class HomeController < ApplicationController
  def index
    @dri = params[:dri]
    company = Company.find_by(droplet_installation_uuid: @dri)
    @integration_settings = company&.integration_setting
  end
end
