# frozen_string_literal: true

# Maps a Fluid order's shipping method title (e.g. "Ground Shipping") to the
# ShipStation carrier/service/package codes that should be requested when the
# order is pushed to ShipStation. One row per (company, fluid_shipping_title).
class ShippingMethodMapping < ApplicationRecord
  belongs_to :company

  validates :fluid_shipping_title, presence: true,
    uniqueness: { scope: :company_id, case_sensitive: false }

  # ShipStation requires a carrier and service together — a carrier alone is
  # rejected at order-push time ("Invalid serviceCode", HTTP 400). Enforce the
  # pairing here so an incomplete mapping can't be saved in the first place.
  validates :service_code, presence: true, if: -> { carrier_code.present? }

  # True when this mapping actually carries a ShipStation code to request.
  # A title with no codes still suppresses the "unmapped" warning but sends no
  # requestedShippingService override beyond the title itself.
  def any_code?
    carrier_code.present? || service_code.present? || package_code.present?
  end
end
