# frozen_string_literal: true

class AddApiVersionToIntegrationSettings < ActiveRecord::Migration[8.0]
  def change
    add_column :integration_settings, :api_version, :string, default: "v1", null: false
  end
end
