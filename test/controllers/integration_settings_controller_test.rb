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

  it "preserves stored secrets when a save omits them" do
    company.create_integration_setting!(
      settings: { "api_key" => "k", "api_secret" => "s", "v2_api_key" => "v2k" },
    )
    post integration_settings_url,
      params: { dri: dri, integration_setting: { hold_for_batch: "true", batch_window_minutes: "15" } },
      headers: xhr
    must_respond_with :created
    setting = company.reload.integration_setting
    _(setting.settings["api_key"]).must_equal "k"
    _(setting.settings["api_secret"]).must_equal "s"
    _(setting.settings["v2_api_key"]).must_equal "v2k"
    _(setting.batch_window_minutes).must_equal 15
  end

  it "does not wipe a stored secret when its field is sent blank" do
    company.create_integration_setting!(settings: { "api_key" => "k", "api_secret" => "s" })
    post integration_settings_url,
      params: { dri: dri, integration_setting: { api_key: "", api_secret: "" } },
      headers: xhr
    must_respond_with :created
    setting = company.reload.integration_setting
    _(setting.settings["api_key"]).must_equal "k"
    _(setting.settings["api_secret"]).must_equal "s"
  end

  it "replaces a stored secret when a new value is provided" do
    company.create_integration_setting!(settings: { "api_key" => "old", "api_secret" => "s" })
    post integration_settings_url,
      params: { dri: dri, integration_setting: { api_key: "new" } },
      headers: xhr
    must_respond_with :created
    setting = company.reload.integration_setting
    _(setting.settings["api_key"]).must_equal "new"
    _(setting.settings["api_secret"]).must_equal "s"
  end

  it "rejects a zero or negative batch window" do
    post integration_settings_url,
      params: { dri: dri, integration_setting: {
        api_key: "k", api_secret: "s", hold_for_batch: "true", batch_window_minutes: "0",
      }, },
      headers: xhr
    must_respond_with :unprocessable_entity
  end

  it "requires the XHR header" do
    post integration_settings_url,
      params: { dri: dri, integration_setting: { api_key: "k", api_secret: "s" } }
    must_respond_with :unauthorized
  end

  it "saves the api_version and v2 api key" do
    post integration_settings_url,
      params: { dri: dri, integration_setting: {
        api_key: "k", api_secret: "s", api_version: "v2", v2_api_key: "TEST_abc",
      }, },
      headers: xhr
    must_respond_with :created
    setting = company.reload.integration_setting
    _(setting.api_version).must_equal "v2"
    _(setting.v2_api_key).must_equal "TEST_abc"
    _(setting.sandbox?).must_equal true
  end

  it "rejects an invalid api_version" do
    post integration_settings_url,
      params: { dri: dri, integration_setting: { api_key: "k", api_secret: "s", api_version: "v9" } },
      headers: xhr
    must_respond_with :unprocessable_entity
  end

  it "saves the selected store_id and clears it when blank" do
    post integration_settings_url,
      params: { dri: dri, integration_setting: { api_key: "k", api_secret: "s", store_id: "3618888" } },
      headers: xhr
    must_respond_with :created
    _(company.reload.integration_setting.store_id).must_equal "3618888"

    post integration_settings_url,
      params: { dri: dri, integration_setting: { api_key: "k", api_secret: "s", store_id: "" } },
      headers: xhr
    must_respond_with :created
    _(company.reload.integration_setting.store_id).must_be_nil
  end

  it "reports the V2 connection result including sandbox" do
    company.create_integration_setting!(
      settings: { "api_key" => "k", "api_secret" => "s", "v2_api_key" => "TEST_abc" }, api_version: "v2",
    )
    HTTParty.stub(:get, OpenStruct.new(code: 200)) do
      post test_v2_connection_integration_settings_url,
        params: { dri: dri }, headers: xhr
    end
    must_respond_with :success
    body = JSON.parse(response.body)
    _(body["connected"]).must_equal true
    _(body["sandbox"]).must_equal true
  end
end
