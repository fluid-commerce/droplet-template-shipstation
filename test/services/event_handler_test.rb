require "test_helper"

# Define test handler classes
class TestHandlerJob < ApplicationJob
  def perform(payload)
    # Test implementation
  end
end

class V1HandlerJob < ApplicationJob
end

class V2HandlerJob < ApplicationJob
end

class FallbackHandlerJob < ApplicationJob
end

class VersionedEventHandler < ApplicationJob
end

class ErrorHandlerJob < ApplicationJob
  def self.perform_later(*)
    raise "Test exception"
  end
end

class MultiArgHandlerJob < ApplicationJob
end

class CustomRuntimeHandlerJob < ApplicationJob
end

describe EventHandler do
  include ActiveJob::TestHelper

  before do
    # Clear the handlers before each test to start with a clean slate
    EventHandler::EVENT_HANDLERS.clear
  end

  after do
    # Restore the real default handlers (must match
    # config/initializers/event_handler.rb) so this test does not corrupt the
    # class-level EVENT_HANDLERS registry for subsequent tests.
    EventHandler::EVENT_HANDLERS.clear
    EventHandler.register_handler("droplet.uninstalled", DropletUninstalledJob)
    EventHandler.register_handler("droplet.installed", DropletInstalledJob)
    EventHandler.register_handler("order.created", OrderCreatedJob)
    EventHandler.register_handler("order.updated", OrderUpdatedJob)
    EventHandler.register_handler("order.cancelled", OrderUpdatedJob)
    EventHandler.register_handler("order.refunded", OrderUpdatedJob)
    EventHandler.register_handler("order.shipped", OrderShippedJob)
  end

  describe "handler registration and routing" do
    it "registers a handler" do
      # Register the handler
      EventHandler.register_handler("test.event", TestHandlerJob)

      # Check that it was registered
      _(EventHandler::EVENT_HANDLERS["test.event"]).must_equal TestHandlerJob
    end

    it "routes to a handler" do
      # Register the handler
      EventHandler.register_handler("test.event", TestHandlerJob)

      # Test routing with payload
      payload = { "test" => "data" }

      assert_enqueued_with(job: TestHandlerJob, args: [ payload ]) do
        result = EventHandler.route("test.event", payload)
        _(result).must_equal true
      end
    end

    it "returns false when routing unknown event type" do
      assert_no_enqueued_jobs do
        result = EventHandler.route("unknown.event", {})
        _(result).must_equal false
      end
    end
  end

  describe "versioned handlers" do
    it "supports version-specific handlers" do
      # Register handlers for different versions
      EventHandler.register_handler("api.event", V1HandlerJob, version: "v1")
      EventHandler.register_handler("api.event", V2HandlerJob, version: "v2")

      # Test that version-specific routing works
      test_payload = { "version_test" => true }

      assert_enqueued_with(job: V1HandlerJob, args: [ test_payload ]) do
        EventHandler.route("api.event", test_payload, version: "v1")
      end

      assert_enqueued_with(job: V2HandlerJob, args: [ test_payload ]) do
        EventHandler.route("api.event", test_payload, version: "v2")
      end
    end

    it "falls back to unversioned handler if version-specific one missing" do
      # Register only unversioned handler
      EventHandler.register_handler("fallback.event", FallbackHandlerJob)

      # Should use unversioned handler when trying to route to non-existent v3
      test_payload = { "fallback" => true }

      assert_enqueued_with(job: FallbackHandlerJob, args: [ test_payload ]) do
        result = EventHandler.route("fallback.event", test_payload, version: "v3")
        _(result).must_equal true
      end
    end

    it "handles explicit version in event name" do
      # Register with explicit version string
      EventHandler.register_handler("data.update", VersionedEventHandler, version: "v2")

      # Test matching with fully qualified event name
      test_payload = { "data" => "test" }

      assert_enqueued_with(job: VersionedEventHandler, args: [ test_payload ]) do
        result = EventHandler.route("v2.data.update", test_payload)
        _(result).must_equal true
      end
    end
  end

  describe "error handling" do
    it "handles non-job handler gracefully" do
      # Register a handler that doesn't respond to perform_later
      invalid_handler = Object.new
      EventHandler.register_handler("invalid.handler", invalid_handler)

      # Should log error and return false
      assert_no_enqueued_jobs do
        result = EventHandler.route("invalid.handler", {})
        _(result).must_equal false
      end
    end

    it "handles exceptions during routing" do
      EventHandler.register_handler("error.event", ErrorHandlerJob)

      # Should catch exception, log it, and return false
      assert_no_enqueued_jobs do
        result = EventHandler.route("error.event", {})
        _(result).must_equal false
      end
    end
  end

  describe "argument handling" do
    it "passes multiple arguments correctly" do
      EventHandler.register_handler("multi.arg", MultiArgHandlerJob)

      # Test with multiple arguments
      arg1 = { "first" => "arg" }
      arg2 = { "second" => "arg" }
      arg3 = "third_arg"

      assert_enqueued_with(job: MultiArgHandlerJob, args: [ arg1, arg2, arg3 ]) do
        result = EventHandler.route("multi.arg", arg1, arg2, arg3)
        _(result).must_equal true
      end
    end
  end

  describe "integration with existing jobs" do
    it "works with existing job classes" do
      # Test with actual job classes
      test_payload = {
        "company_droplet" => {
          "fluid_shop" => "test-shop",
          "name" => "Test Company",
          "fluid_company_id" => 123,
          "company_droplet_uuid" => "abc-123-xyz",
          "authentication_token" => "secret-token",
          "webhook_verification_token" => "verify-token",
        },
      }

      # Register the default handlers
      EventHandler.register_handler("company_droplet.created", DropletInstalledJob)

      assert_enqueued_with(job: DropletInstalledJob, args: [ test_payload ]) do
        result = EventHandler.route("company_droplet.created", test_payload)
        _(result).must_equal true
      end
    end

    it "can register custom handler at runtime" do
      # Register the handler at runtime
      EventHandler.register_handler("custom.runtime", CustomRuntimeHandlerJob)

      # Test routing to the custom handler
      test_payload = { "runtime" => "test" }

      assert_enqueued_with(job: CustomRuntimeHandlerJob, args: [ test_payload ]) do
        result = EventHandler.route("custom.runtime", test_payload)
        _(result).must_equal true
      end
    end
  end
end
