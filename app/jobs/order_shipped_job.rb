# frozen_string_literal: true

class OrderShippedJob < WebhookEventJob
  def process_webhook
    payload = get_payload
    company = get_company

    # payload for shipped webhook is the resource_url string, not a hash
    # We need company_id to look up credentials
    resource_url = payload.is_a?(String) ? payload : payload["resource_url"]
    company_id = company&.id || payload["company_id"]

    sync_service = Shipstation::SyncShippedOrder.new(resource_url, company_id)
    sync_service.call
  end
end
