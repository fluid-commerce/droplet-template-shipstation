require "test_helper"

describe IntegrationSettingsController do
  fixtures(:companies)

  let(:company) { companies(:acme) }
  let(:dri) { company.droplet_installation_uuid }
  let(:xhr) { { "X-Requested-With" => "XMLHttpRequest" } }

  it "saves credentials plus batching settings" do
    post integration_settings_url,
      params: { dri: dri, integration_setting: {
        api_key: "k", api_secret: "s", hold_for_batch: "true", batch_window_minutes: "45",
      }, },
      headers: xhr
    must_respond_with :created
    setting = company.reload.integration_setting
    _(setting.hold_for_batch).must_equal true
    _(setting.batch_window_minutes).must_equal 45
  end

  it "treats a blank batch window as nil (manual release)" do
    post integration_settings_url,
      params: { dri: dri, integration_setting: {
        api_key: "k", api_secret: "s", hold_for_batch: "true", batch_window_minutes: "",
      }, },
      headers: xhr
    must_respond_with :created
    _(company.reload.integration_setting.batch_window_minutes).must_be_nil
  end

  it "preserves batching settings on a credentials-only save" do
    company.create_integration_setting!(
      settings: { "api_key" => "k" }, hold_for_batch: true, batch_window_minutes: 30,
    )
    post integration_settings_url,
      params: { dri: dri, integration_setting: { api_key: "k2", api_secret: "s2" } },
      headers: xhr
    must_respond_with :created
    setting = company.reload.integration_setting
    _(setting.hold_for_batch).must_equal true
    _(setting.batch_window_minutes).must_equal 30
  end

  it "requires the XHR header" do
    post integration_settings_url,
      params: { dri: dri, integration_setting: { api_key: "k", api_secret: "s" } }
    must_respond_with :unauthorized
  end
end
