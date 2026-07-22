require "test_helper"

describe HomeController do
  fixtures(:companies)

  let(:company) { companies(:acme) }

  it "gets index" do
    get root_url
    must_respond_with :success
  end

  it "never renders stored secrets into the DOM" do
    company.create_integration_setting!(
      settings: {
        "api_key" => "SECRET_KEY_VALUE",
        "api_secret" => "SECRET_SECRET_VALUE",
        "v2_api_key" => "SECRET_V2_VALUE",
      },
    )
    get root_url(dri: company.droplet_installation_uuid)
    must_respond_with :success
    _(response.body).wont_include "SECRET_KEY_VALUE"
    _(response.body).wont_include "SECRET_SECRET_VALUE"
    _(response.body).wont_include "SECRET_V2_VALUE"
    # Only presence flags are exposed.
    _(response.body).must_include 'data-api-key-set="true"'
    _(response.body).must_include 'data-v2-api-key-set="true"'
  end

  it "does not render config for an inactive (uninstalled) install" do
    company.update!(active: false)
    company.create_integration_setting!(settings: { "api_key" => "SECRET_KEY_VALUE" })
    get root_url(dri: company.droplet_installation_uuid)
    must_respond_with :success
    _(response.body).wont_include "SECRET_KEY_VALUE"
    _(response.body).must_include 'data-api-key-set="false"'
  end
end
