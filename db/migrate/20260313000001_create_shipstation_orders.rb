class CreateShipstationOrders < ActiveRecord::Migration[8.0]
  def change
    create_table :shipstation_orders do |t|
      t.references :company, null: false, foreign_key: true

      # Fluid order identifiers
      t.bigint :fluid_order_id, null: false
      t.string :fluid_order_number, null: false

      # ShipStation order identifiers (populated after successful submission)
      t.string :shipstation_order_id
      t.string :shipstation_order_key

      # Status tracking
      t.string :status, null: false, default: "PENDING"
      t.text :last_error
      t.datetime :last_error_at
      t.integer :retry_count, null: false, default: 0

      # Tracking info (populated when ShipStation ships)
      t.string :tracking_numbers, array: true, default: []
      t.string :carrier
      t.string :tracking_url
      t.datetime :shipped_at

      # Fluid sync state
      t.boolean :tracking_synced_to_fluid, null: false, default: false
      t.datetime :tracking_synced_at

      # Store original Fluid payload for retries
      t.jsonb :request_payload, default: {}
      t.jsonb :response_payload, default: {}

      t.timestamps
    end

    add_index :shipstation_orders, :fluid_order_id
    add_index :shipstation_orders, :fluid_order_number
    add_index :shipstation_orders, :shipstation_order_id
    add_index :shipstation_orders, :status
    add_index :shipstation_orders, [:status, :tracking_synced_to_fluid],
              name: "index_ss_orders_on_status_and_sync"
  end
end
