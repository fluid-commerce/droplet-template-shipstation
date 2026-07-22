require "test_helper"

describe Shipstation::V2::TestConnection do
  describe "#call" do
    it "reports connected and sandbox for a TEST_ key that ShipStation accepts" do
      IntegrationSetting.stub(:find_by, OpenStruct.new(v2_api_key: "TEST_abc")) do
        HTTParty.stub(:get, OpenStruct.new(code: 200)) do
          result = Shipstation::V2::TestConnection.new(1).call
          _(result[:connected]).must_equal true
          _(result[:sandbox]).must_equal true
        end
      end
    end

    it "reports connected and non-sandbox for a production key" do
      IntegrationSetting.stub(:find_by, OpenStruct.new(v2_api_key: "live_key")) do
        HTTParty.stub(:get, OpenStruct.new(code: 200)) do
          result = Shipstation::V2::TestConnection.new(1).call
          _(result[:connected]).must_equal true
          _(result[:sandbox]).must_equal false
        end
      end
    end

    it "reports not connected when ShipStation rejects the key" do
      IntegrationSetting.stub(:find_by, OpenStruct.new(v2_api_key: "TEST_bad")) do
        HTTParty.stub(:get, OpenStruct.new(code: 401)) do
          _(Shipstation::V2::TestConnection.new(1).call[:connected]).must_equal false
        end
      end
    end

    it "reports not connected when no key is configured" do
      IntegrationSetting.stub(:find_by, OpenStruct.new(v2_api_key: nil)) do
        _(Shipstation::V2::TestConnection.new(1).call[:connected]).must_equal false
      end
    end

    it "reports not connected when the request raises" do
      IntegrationSetting.stub(:find_by, OpenStruct.new(v2_api_key: "TEST_x")) do
        HTTParty.stub(:get, ->(*_a, **_k) { raise "boom" }) do
          _(Shipstation::V2::TestConnection.new(1).call[:connected]).must_equal false
        end
      end
    end
  end
end
