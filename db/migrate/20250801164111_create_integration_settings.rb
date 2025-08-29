class CreateIntegrationSettings < ActiveRecord::Migration[8.0]
  def change
    unless table_exists?(:integration_settings)
      create_table :integration_settings do |t|
        t.references :company, null: false, foreign_key: true
        t.boolean :enabled, default: false
        t.jsonb :settings, default: {}
        t.jsonb :credentials, default: {}

        t.timestamps
      end
    end
  end
end
