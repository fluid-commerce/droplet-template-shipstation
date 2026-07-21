# frozen_string_literal: true

class CreateShippingMethodMappings < ActiveRecord::Migration[8.0]
  def change
    create_table :shipping_method_mappings do |t|
      t.references :company, null: false, foreign_key: true
      t.string :fluid_shipping_title, null: false
      t.string :carrier_code
      t.string :service_code
      t.string :package_code
      t.string :description

      t.timestamps
    end

    add_index :shipping_method_mappings, %i[company_id fluid_shipping_title],
      unique: true, name: "index_ship_method_maps_on_company_and_title"
  end
end
