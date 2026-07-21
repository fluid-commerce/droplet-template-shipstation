# frozen_string_literal: true

# Maps a Fluid order's shipping method title (e.g. "Ground Shipping") to the
# ShipStation carrier/service/package codes that should be requested when the
# order is pushed to ShipStation. One row per (company, fluid_shipping_title).
class ShippingMethodMapping < ApplicationRecord
  belongs_to :company

  validates :fluid_shipping_title, presence: true,
    uniqueness: { scope: :company_id, case_sensitive: false }

  # True when this mapping actually carries a ShipStation code to request.
  # A title with no codes still suppresses the "unmapped" warning but sends no
  # requestedShippingService override beyond the title itself.
  def any_code?
    carrier_code.present? || service_code.present? || package_code.present?
  end
end
