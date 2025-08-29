class AddDropletInstallationUuidToCompanies < ActiveRecord::Migration[8.0]
  def change
    unless column_exists?(:companies, :droplet_installation_uuid)
      add_column :companies, :droplet_installation_uuid, :string
    end
  end
end
