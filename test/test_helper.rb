ENV["RAILS_ENV"] ||= "test"
# Consider setting MT_NO_EXPECTATIONS to not add expectations to Object.
# ENV["MT_NO_EXPECTATIONS"] = "true"
require_relative "../config/environment"
require "rails/test_help"
require "minitest/rails"

# Minimal stand-in for an HTTParty::Response used when stubbing ShipStation
# POSTs: the service reads #parsed_response and #code off whatever is returned.
class FakeResponse
  def initialize(body, code = 200)
    @body = body
    @code = code
  end

  attr_reader :code

  def parsed_response
    @body
  end

  def [](key)
    @body[key]
  end
end

module ActiveSupport
  class TestCase
    # Run tests in parallel with specified workers
    parallelize(workers: :number_of_processors)

    # Setup all fixtures in test/fixtures/*.yml for all tests in alphabetical order.
    fixtures :all

    # Add more helper methods to be used by all tests here...
  end
end

class ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers
end
