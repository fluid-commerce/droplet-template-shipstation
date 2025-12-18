# project id and region
project_id = "fluid-417204"
region = "europe-west1"

# service account email
service_account_email = "106074092699-compute@developer.gserviceaccount.com"

# container image
container_image = "europe-west1-docker.pkg.dev/fluid-417204/fluid-droplets/fluid-droplet-shipstation-rails/web:latest"

# environment variables
environment_variables = {
  "RACK_ENV"            = "production",
  "RAILS_ENV"           = "production",
  "RAILS_LOG_TO_STDOUT" = "enabled",
  "RAILS_MASTER_KEY"    = ""
}

environment_secrets = {
  "DATABASE_URL" = "SHIPSTATION_DATABASE_URL"
  "CACHE_DATABASE_URL" = "SHIPSTATION_CACHE_DATABASE_URL"
  "QUEUE_DATABASE_URL" = "SHIPSTATION_QUEUE_DATABASE_URL"
  "CABLE_DATABASE_URL" = "SHIPSTATION_CABLE_DATABASE_URL"
}