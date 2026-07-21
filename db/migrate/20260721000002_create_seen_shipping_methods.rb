# frozen_string_literal: true

class CreateSeenShippingMethods < ActiveRecord::Migration[8.0]
  def change
    create_table :seen_shipping_methods do |t|
      t.references :company, null: false, foreign_key: true
      t.string :fluid_shipping_title, null: false
      t.integer :seen_count, null: false, default: 1
      t.datetime :last_seen_at, null: false
      t.string :example_order_number

      t.timestamps
    end

    add_index :seen_shipping_methods, %i[company_id fluid_shipping_title],
      unique: true, name: "index_seen_ship_methods_on_company_and_title"
  end
end
