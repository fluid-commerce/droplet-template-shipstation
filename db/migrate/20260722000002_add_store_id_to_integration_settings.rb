# frozen_string_literal: true

# Optional ShipStation store to assign created orders to (advancedOptions.storeId).
# Nil = ShipStation's default store for the API key (today's behavior).
class AddStoreIdToIntegrationSettings < ActiveRecord::Migration[8.0]
  def change
    add_column :integration_settings, :store_id, :string
  end
end
