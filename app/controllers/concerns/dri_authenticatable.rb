# frozen_string_literal: true

# DriAuthenticatable provides capability-based authentication for the embedded
# droplet UI and the API endpoints it calls.
#
# When Fluid embeds the droplet in an iframe it passes the installation's
# unguessable droplet_installation_uuid (DRI) as `?dri=...`. The DRI identifies
# a single installation, so resolving the company from it — rather than trusting
# a client-supplied company_id — is what authenticates and scopes the request.
#
# The DRI is accepted from the query string or the JSON body (for mutations
# where a query param is awkward) and cached in the session so follow-up
# requests in the same embedded session don't have to resend it.
module DriAuthenticatable
  extend ActiveSupport::Concern

  # Resolves and requires the current company from the DRI. Renders 401 when the
  # DRI is missing or does not map to an active installation.
  def authenticate_dri
    if extract_dri.blank?
      return render json: { error: "Unauthorized: droplet_installation_uuid missing" }, status: :unauthorized
    end

    unless current_company
      return render json: { error: "Unauthorized: installation not found" }, status: :unauthorized
    end

    session[:droplet_installation_uuid] = extract_dri
    true
  end

  # The company for the current DRI, or nil. Memoized.
  def current_company
    return @current_company if defined?(@current_company)

    dri = extract_dri
    @current_company = dri.present? ? Company.active.find_by(droplet_installation_uuid: dri) : nil
  end

  # The current company's integration setting, or nil.
  def current_integration_setting
    @current_integration_setting ||= current_company&.integration_setting
  end

private

  def extract_dri
    params[:dri].presence || session[:droplet_installation_uuid].presence
  end
end
