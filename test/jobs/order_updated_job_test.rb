require "test_helper"

class OrderUpdatedJobTest < ActiveSupport::TestCase
  test "is registered for the order.updated event" do
    _(EventHandler::EVENT_HANDLERS["order.updated"]).must_equal OrderUpdatedJob
  end

  test "delegates the payload to Shipstation::CreateOrder" do
    received = nil
    called = false
    fake = Object.new
    fake.define_singleton_method(:call) { called = true }
    Shipstation::CreateOrder.stub(:new, ->(payload) { received = payload; fake }) do
      job = OrderUpdatedJob.new
      job.instance_variable_set(:@payload, { "order" => { "id" => 1 } })
      job.process_webhook
    end
    _(called).must_equal true
    _(received).must_equal({ "order" => { "id" => 1 } })
  end
end
