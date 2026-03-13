require "test_helper"

describe WebhookController, "shipped action" do
  fixtures(:companies, :settings)

  let(:acme) { companies(:acme) }
  let(:auth_token) { settings(:fluid_webhook).values["auth_token"] }

  describe "POST /webhook/shipped" do
    it "returns 401 without auth token" do
      post shipped_webhook_index_url, params: {
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
        company_id: acme.fluid_company_id,
      }

      _(response).must_be :unauthorized?
    end

    it "returns 401 with wrong auth token" do
      post shipped_webhook_index_url, params: {
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => "wrong-token" }

      _(response).must_be :unauthorized?
    end

    it "returns 202 with valid auth token" do
      post shipped_webhook_index_url, params: {
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => auth_token }

      _(response.status).must_equal 202
    end

    it "returns 400 when resource_url is missing" do
      post shipped_webhook_index_url, params: {
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => auth_token }

      _(response).must_be :bad_request?
    end

    it "enqueues OrderShippedJob" do
      assert_enqueued_with(job: OrderShippedJob) do
        post shipped_webhook_index_url, params: {
          resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
          company_id: acme.fluid_company_id,
        }, headers: { "X-Auth-Token" => auth_token }
      end
    end
  end
end
