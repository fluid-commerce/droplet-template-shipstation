require "test_helper"

describe DropletInstalledJob do
  fixtures(:companies, :callbacks)

  def install_payload
    {
      "company" => {
        "fluid_shop" => "install-test.fluid.app",
        "name" => "Install Test",
        "fluid_company_id" => 777_001,
        "droplet_uuid" => "cdu-777",
        "authentication_token" => "dit_install_test",
        "webhook_verification_token" => "wvt_install_test",
        "droplet_installation_uuid" => "dri_install_test",
      },
    }
  end

  # Builds a FluidClient double whose callback registration is a no-op and
  # whose webhook registration behaves as configured.
  def stub_client(webhooks_create:)
    callbacks = Object.new
    callbacks.define_singleton_method(:create) { |*| { "callback_registration" => { "uuid" => "cb" } } }

    webhooks = Object.new
    webhooks.define_singleton_method(:create, &webhooks_create)

    client = Object.new
    client.define_singleton_method(:callback_registrations) { callbacks }
    client.define_singleton_method(:webhooks) { webhooks }
    client
  end

  describe "#perform" do
    it "creates the company from the payload" do
      client = stub_client(webhooks_create: ->(*) { { "id" => 1 } })

      FluidClient.stub(:new, client) do
        _(-> { DropletInstalledJob.perform_now(install_payload) }).must_change "Company.count", +1
      end

      company = Company.find_by(fluid_company_id: 777_001)
      _(company).wont_be_nil
      _(company.droplet_installation_uuid).must_equal "dri_install_test"
      _(company).must_be :active?
    end

    it "still creates the company when order webhook registration raises" do
      client = stub_client(webhooks_create: ->(*) { raise "ShipStation registration failed" })

      FluidClient.stub(:new, client) do
        _(-> { DropletInstalledJob.perform_now(install_payload) }).must_change "Company.count", +1
      end

      _(Company.find_by(fluid_company_id: 777_001)).wont_be_nil
    end
  end
end
