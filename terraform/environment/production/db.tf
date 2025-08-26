# Cloud SQL PostgreSQL instance
module "postgres_db_instance" {
  source = "../../modules/cloud_sql_postgres"

  instance_name    = "fluid-droplet-shipstation"
  database_version = "POSTGRES_17"
  region           = var.region

  edition = "ENTERPRISE"

  tier              = "db-g1-small" # the machine type to use
  disk_size         = 10
  high_availability = false

  # labels for the instance
  project     = var.project
  environment = var.environment

  # IP configuration for the instance
  ipv4_enabled = true

}
