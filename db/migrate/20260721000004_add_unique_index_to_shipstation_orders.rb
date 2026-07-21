# frozen_string_literal: true

class AddUniqueIndexToShipstationOrders < ActiveRecord::Migration[8.0]
  def up
    # Remove any duplicate (company_id, fluid_order_id) rows the previous
    # non-unique tracking allowed, keeping the most recently created (highest id).
    execute <<~SQL.squish
      DELETE FROM shipstation_orders a
      USING shipstation_orders b
      WHERE a.company_id = b.company_id
        AND a.fluid_order_id = b.fluid_order_id
        AND a.id < b.id
    SQL

    add_index :shipstation_orders, %i[company_id fluid_order_id],
      unique: true, name: "index_ss_orders_on_company_and_fluid_order_id"
  end

  def down
    remove_index :shipstation_orders, name: "index_ss_orders_on_company_and_fluid_order_id"
  end
end
