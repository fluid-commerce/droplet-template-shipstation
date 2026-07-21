# frozen_string_literal: true

# Records every distinct shipping method title observed on incoming Fluid orders
# so the admin can see which titles still need a ShippingMethodMapping. Tracking
# is best-effort and must never block order processing.
class SeenShippingMethod < ApplicationRecord
  belongs_to :company

  validates :fluid_shipping_title, presence: true,
    uniqueness: { scope: :company_id, case_sensitive: false }

  # Upserts the seen record for a title, incrementing the count. Swallows errors
  # (including the unique-index race under concurrent orders) because tracking is
  # non-critical to fulfilling the order.
  def self.record!(company:, title:, order_number: nil)
    return if title.blank?

    seen = company.seen_shipping_methods.find_or_initialize_by(fluid_shipping_title: title)
    seen.seen_count = seen.new_record? ? 1 : seen.seen_count + 1
    seen.last_seen_at = Time.current
    seen.example_order_number ||= order_number
    seen.save!
  rescue StandardError => e
    Rails.logger.warn("[SeenShippingMethod] failed to record #{title.inspect}: #{e.message}")
  end
end
