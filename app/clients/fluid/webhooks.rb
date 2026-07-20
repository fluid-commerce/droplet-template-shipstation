module Fluid
  module Webhooks
    def webhooks
      @webhooks ||= Resource.new(self)
    end

    class Resource
      def initialize(client)
        @client = client
      end

      def get
        @client.get("/api/company/webhooks")
      end

      def create(attributes = {})
        @client.post("/api/company/webhooks", body: payload(attributes))
      end

      def update(webhook_id, attributes = {})
        @client.put("/api/company/webhooks/#{webhook_id}", body: payload(attributes))
      end

      def delete(webhook_id)
        @client.delete("/api/company/webhooks/#{webhook_id}")
      end

      def payload(attributes = {})
        {
          "webhook" => {
            "resource" => attributes[:resource] || "droplet",
            "url" => attributes[:url] || webhook_url,
            "active" => attributes[:active] || true,
            "auth_token" => attributes[:auth_token] || SecureRandom.hex(32),
            "event" => attributes[:event] || "installed",
            "http_method" => attributes[:http_method] || "post",
          },
        }
      end

    private

      # The public URL Fluid should POST this droplet's webhooks to. Built from
      # the droplet's own base URL (APP_URL, falling back to the host_server
      # setting) plus the webhook path. `resources :webhook` generates the
      # `webhook_index_*` helpers because the resource name is singular.
      def webhook_url
        base = ENV["APP_URL"].presence || Setting.host_server.base_url
        "#{base.chomp('/')}#{Rails.application.routes.url_helpers.webhook_index_path}"
      end
    end
  end
end
