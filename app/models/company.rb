class Company < ApplicationRecord
  has_many :events, dependent: :destroy
  has_many :shipstation_orders, dependent: :destroy
  has_many :shipping_method_mappings, dependent: :destroy
  has_many :seen_shipping_methods, dependent: :destroy
  has_one :integration_setting, dependent: :destroy

  validates :fluid_shop, :authentication_token, :name, :fluid_company_id, :company_droplet_uuid, presence: true
  validates :authentication_token, uniqueness: true

  scope :active, -> { where(active: true) }

  after_initialize :set_default_installed_callback_ids, if: :new_record?

private

  def set_default_installed_callback_ids
    self.installed_callback_ids ||= []
  end
end
