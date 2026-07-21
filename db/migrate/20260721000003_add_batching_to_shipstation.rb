# frozen_string_literal: true

class AddBatchingToShipstation < ActiveRecord::Migration[8.0]
  def change
    add_column :integration_settings, :hold_for_batch, :boolean, default: false, null: false
    add_column :integration_settings, :batch_window_minutes, :integer

    add_column :shipstation_orders, :hold_until, :datetime
    add_index :shipstation_orders, %i[status hold_until], name: "index_ss_orders_on_status_and_hold_until"
  end
end
