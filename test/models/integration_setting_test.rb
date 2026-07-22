require "test_helper"

describe IntegrationSetting do
  fixtures(:companies)

  let(:company) { companies(:acme) }

  it "defaults api_version to v1" do
    setting = company.build_integration_setting
    _(setting.api_version).must_equal "v1"
    _(setting.v2?).must_equal false
  end

  it "rejects an unknown api_version" do
    setting = company.build_integration_setting(api_version: "v3")
    _(setting).wont_be :valid?
  end

  it "reads the v2 api key from settings" do
    setting = company.build_integration_setting(settings: { "v2_api_key" => "TEST_abc" })
    _(setting.v2_api_key).must_equal "TEST_abc"
  end

  describe "#sandbox?" do
    it "is true for a TEST_ prefixed v2 key" do
      _(company.build_integration_setting(settings: { "v2_api_key" => "TEST_abc" }).sandbox?).must_equal true
    end

    it "is false for a production v2 key" do
      _(company.build_integration_setting(settings: { "v2_api_key" => "live" }).sandbox?).must_equal false
    end

    it "is false when no v2 key is set" do
      _(company.build_integration_setting(settings: {}).sandbox?).must_equal false
    end
  end
end
