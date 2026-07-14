require "test_helper"

describe Shipstation::TestConnection do
  describe "#call" do
    let(:valid_setting) { OpenStruct.new(settings: { "api_key" => "key", "api_secret" => "secret" }) }

    it "returns true when ShipStation accepts the credentials" do
      IntegrationSetting.stub(:find_by, valid_setting) do
        HTTParty.stub(:get, OpenStruct.new(code: 200)) do
          _(Shipstation::TestConnection.new(1).call).must_equal true
        end
      end
    end

    it "returns false when ShipStation rejects the credentials" do
      IntegrationSetting.stub(:find_by, valid_setting) do
        HTTParty.stub(:get, OpenStruct.new(code: 401)) do
          _(Shipstation::TestConnection.new(1).call).must_equal false
        end
      end
    end

    it "returns false when credentials are missing" do
      IntegrationSetting.stub(:find_by, OpenStruct.new(settings: {})) do
        _(Shipstation::TestConnection.new(1).call).must_equal false
      end
    end

    it "returns false when no integration setting exists" do
      IntegrationSetting.stub(:find_by, nil) do
        _(Shipstation::TestConnection.new(1).call).must_equal false
      end
    end

    it "returns false when the request raises" do
      IntegrationSetting.stub(:find_by, valid_setting) do
        HTTParty.stub(:get, ->(*_args, **_kwargs) { raise "boom" }) do
          _(Shipstation::TestConnection.new(1).call).must_equal false
        end
      end
    end
  end
end
