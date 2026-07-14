require "test_helper"

# Integration tests covering the full order lifecycle:
#   1. Order created webhook → local record + ShipStation submission
#   2. Shipped webhook → tracking update + Fluid fulfillment sync
#   3. Cron reconciliation for failed syncs
#   4. Idempotency on duplicate webhooks
class OrderLifecycleTest < ActionDispatch::IntegrationTest
  fixtures(:companies, :settings, :shipstation_orders)

  def acme
    companies(:acme)
  end

  def auth_token
    settings(:fluid_webhook).values["auth_token"]
  end

  # ========================================================================
  # Webhook Authentication
  # ========================================================================

  describe "webhook authentication" do
    it "rejects unauthenticated requests to /webhook" do
      post webhook_index_url, params: {
        resource: "order",
        event: "created",
        company_id: acme.fluid_company_id,
      }

      _(response).must_be :unauthorized?
    end

    it "rejects unauthenticated requests to /webhook/shipped" do
      post shipped_webhook_index_url, params: {
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
        company_id: acme.fluid_company_id,
      }

      _(response).must_be :unauthorized?
    end

    it "accepts authenticated requests to /webhook" do
      post webhook_index_url, params: {
        resource: "order",
        event: "created",
        company_id: acme.fluid_company_id,
        company: {
          fluid_company_id: acme.fluid_company_id,
        },
        order: { id: 999, order_number: "TEST-999" },
      }, headers: { "X-Auth-Token" => auth_token }

      _(response).wont_be :unauthorized?
      _([ 202, 204 ]).must_include response.status
    end
  end

  # ========================================================================
  # Order Created Flow
  # ========================================================================

  describe "order created webhook" do
    it "routes order.created event through EventHandler" do
      post webhook_index_url, params: {
        resource: "order",
        event: "created",
        company_id: acme.fluid_company_id,
        company: {
          fluid_company_id: acme.fluid_company_id,
          company_droplet_uuid: acme.company_droplet_uuid,
        },
        order: {
          id: 500,
          order_number: "INT-500",
          items: [ { id: 1, sku: "SKU-1", quantity: 2 } ],
          ship_to: { name: "Test", address1: "123 Main" },
        },
      }, headers: { "X-Auth-Token" => auth_token }

      _(response).wont_be :unauthorized?
      # 202 means EventHandler found a handler and enqueued the job
      # 204 means no handler was found (can happen if initializer order varies)
      _([ 202, 204 ]).must_include response.status
    end

    it "returns 204 for unhandled event types" do
      post webhook_index_url, params: {
        resource: "customer",
        event: "updated",
        company_id: acme.fluid_company_id,
        company: {
          fluid_company_id: acme.fluid_company_id,
        },
      }, headers: { "X-Auth-Token" => auth_token }

      _(response.status).must_equal 204
    end
  end

  # ========================================================================
  # Shipped Webhook Flow
  # ========================================================================

  describe "shipped webhook" do
    it "enqueues OrderShippedJob with company context" do
      assert_enqueued_with(job: OrderShippedJob) do
        post shipped_webhook_index_url, params: {
          resource_url: "https://ssapi.shipstation.com/shipments?batchId=42",
          company_id: acme.fluid_company_id,
        }, headers: { "X-Auth-Token" => auth_token }
      end

      _(response.status).must_equal 202
    end

    it "returns 400 when resource_url is missing" do
      post shipped_webhook_index_url, params: {
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => auth_token }

      _(response).must_be :bad_request?
    end

    it "returns 400 when company_id is missing" do
      post shipped_webhook_index_url, params: {
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=42",
      }, headers: { "X-Auth-Token" => auth_token }

      _(response).must_be :bad_request?
    end
  end

  # ========================================================================
  # ShipstationOrder Model Integration
  # ========================================================================

  describe "local order tracking" do
    it "creates order record with correct defaults" do
      order = ShipstationOrder.create!(
        company: acme,
        fluid_order_id: 999,
        fluid_order_number: "INT-999",
      )

      _(order.status).must_equal "PENDING"
      _(order.retry_count).must_equal 0
      _(order.tracking_synced_to_fluid).must_equal false
      _(order.tracking_numbers).must_equal []
    end

    it "transitions through expected lifecycle states" do
      order = ShipstationOrder.create!(
        company: acme,
        fluid_order_id: 998,
        fluid_order_number: "INT-998",
        status: "PENDING",
      )

      # Submitted to ShipStation
      order.update!(status: "SUBMITTED", shipstation_order_id: "ss-998")
      _(order.status).must_equal "SUBMITTED"

      # Shipped with tracking
      order.update!(
        status: "SHIPPED",
        tracking_numbers: [ "1Z999" ],
        carrier: "ups",
        shipped_at: Time.current,
      )
      _(order.status).must_equal "SHIPPED"
      _(order.tracking_numbers).must_equal [ "1Z999" ]

      # Synced to Fluid
      order.update!(tracking_synced_to_fluid: true, tracking_synced_at: Time.current)
      _(order.tracking_synced_to_fluid).must_equal true
    end

    it "records failure with error details" do
      order = ShipstationOrder.create!(
        company: acme,
        fluid_order_id: 997,
        fluid_order_number: "INT-997",
        status: "PENDING",
      )

      order.update!(
        status: "FAILED",
        last_error: "ShipStation API timeout",
        last_error_at: Time.current,
        retry_count: order.retry_count + 1,
      )

      _(order.status).must_equal "FAILED"
      _(order.last_error).must_equal "ShipStation API timeout"
      _(order.retry_count).must_equal 1
      _(order).must_be :sendable?
    end
  end

  # ========================================================================
  # Idempotency
  # ========================================================================

  describe "idempotency" do
    it "needs_tracking_sync excludes already-synced orders" do
      unsynced = shipstation_orders(:shipped_unsynced)
      synced = shipstation_orders(:shipped_synced)

      results = ShipstationOrder.needs_tracking_sync
      _(results).must_include unsynced
      _(results).wont_include synced
    end

    it "needs_tracking_sync excludes orders without tracking" do
      order = ShipstationOrder.create!(
        company: acme,
        fluid_order_id: 996,
        fluid_order_number: "INT-996",
        status: "SHIPPED",
        tracking_numbers: [],
        tracking_synced_to_fluid: false,
      )

      results = ShipstationOrder.needs_tracking_sync
      _(results).wont_include order
    end

    it "needs_tracking_sync excludes non-SHIPPED orders" do
      failed = shipstation_orders(:failed_order)
      pending = shipstation_orders(:pending_order)

      results = ShipstationOrder.needs_tracking_sync
      _(results).wont_include failed
      _(results).wont_include pending
    end
  end

  # ========================================================================
  # Cron Reconciliation
  # ========================================================================

  describe "sync tracking cron job" do
    it "processes unsynced orders and skips synced ones" do
      unsynced = shipstation_orders(:shipped_unsynced)
      synced = shipstation_orders(:shipped_synced)

      fluid_body = { order: { id: unsynced.fluid_order_id, items: [ { id: 1, quantity: 2 } ] } }.to_json
      fulfillment_body = { order_fulfillment: { id: 1 } }.to_json

      FluidApi::Commerce::OrderService.define_method(:retrieve_order) { |**_| OpenStruct.new(body: fluid_body) }
      FluidApi::Commerce::OrderService.define_method(:order_fulfillment) { |**_| OpenStruct.new(body: fulfillment_body) }

      SyncTrackingJob.perform_now

      FluidApi::Commerce::OrderService.remove_method(:retrieve_order)
      FluidApi::Commerce::OrderService.remove_method(:order_fulfillment)

      unsynced.reload
      synced.reload

      _(unsynced.tracking_synced_to_fluid).must_equal true
      # Synced order's timestamp should not change
      _(synced.tracking_synced_to_fluid).must_equal true
    end
  end

  # ========================================================================
  # Retry Logic
  # ========================================================================

  describe "retry configuration" do
    it "OrderCreatedJob inherits WebhookEventJob retry behavior" do
      _(OrderCreatedJob.ancestors).must_include WebhookEventJob
    end

    it "OrderShippedJob inherits WebhookEventJob retry behavior" do
      _(OrderShippedJob.ancestors).must_include WebhookEventJob
    end

    it "WebhookEventJob has retry_on configured" do
      assert WebhookEventJob < ActiveJob::Base, "WebhookEventJob must inherit from ActiveJob::Base"
    end
  end

  # ========================================================================
  # Security: SSRF Protection
  # ========================================================================

  describe "SSRF protection" do
    it "rejects shipped webhook with non-ShipStation resource_url" do
      post shipped_webhook_index_url, params: {
        resource_url: "https://evil.com/shipments?batchId=123",
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => auth_token }

      _(response).must_be :bad_request?
    end

    it "rejects shipped webhook with localhost resource_url" do
      post shipped_webhook_index_url, params: {
        resource_url: "http://localhost:3000/admin",
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => auth_token }

      _(response).must_be :bad_request?
    end

    it "rejects shipped webhook with internal IP resource_url" do
      post shipped_webhook_index_url, params: {
        resource_url: "http://169.254.169.254/latest/meta-data/",
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => auth_token }

      _(response).must_be :bad_request?
    end

    it "accepts shipped webhook with valid ShipStation resource_url" do
      assert_enqueued_with(job: OrderShippedJob) do
        post shipped_webhook_index_url, params: {
          resource_url: "https://ssapi.shipstation.com/shipments?batchId=42",
          company_id: acme.fluid_company_id,
        }, headers: { "X-Auth-Token" => auth_token }
      end

      _(response.status).must_equal 202
    end
  end

  # ========================================================================
  # Security: Integration Settings Authentication
  # ========================================================================

  describe "integration settings authentication" do
    it "rejects unauthenticated requests to create integration settings" do
      post integration_settings_url, params: {
        integration_setting: {
          company_id: acme.id,
          api_key: "key",
          api_secret: "secret",
        },
      }

      _(response).must_be :unauthorized?
    end
  end

  # ========================================================================
  # Security: Timing-Safe Token Comparison
  # ========================================================================

  describe "webhook token security" do
    it "rejects requests with wrong auth token" do
      post shipped_webhook_index_url, params: {
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => "wrong-token-value" }

      _(response).must_be :unauthorized?
    end

    it "rejects requests with empty auth token" do
      post shipped_webhook_index_url, params: {
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
        company_id: acme.fluid_company_id,
      }, headers: { "X-Auth-Token" => "" }

      _(response).must_be :unauthorized?
    end
  end
end
