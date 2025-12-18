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
  "RAILS_MASTER_KEY"    = "635a34c26e2f937246a01c4e174ed7f6",
  "APP_URL"             = "https://fluid-droplet-shipstation-106074092699.us-west3.run.app",
  "ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY" = "xhkej6XTMr5FKO2F1Vu8KkaklezpvGie",
  "FLUID_COMPANY_TOKEN" = "C-ESwkFfUkCedxDTyuH7nmBzC4",
  "WEEBHOOK_AUTH_TOKEN" = "apCprpDkFaXWRZbp1Lf9dEVPmf6F5csv6MjP",
  "ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY" = "7JDjuadNfiqDSStbegtpfrnYBAoUE54J",
  "ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT" = "Du2r5xbiJv2vGLeR0vObtp9j2lsdfcJQ",
  "ALLOWED_IFRAME_ORIGINS" = "https://api.fluid.app",
  "FLUID_API_URL" = "https://api.fluid.app",
  "FLUID_WEBHOOK_AUTH_TOKEN" = "wvt_iUZlJ7Nyl3T1ORNsinTf8XLazELNpKQt",
  "SOLID_QUEUE_IN_PUMA" = "true"
}

environment_secrets = {
  "DATABASE_URL" = "SHIPSTATION_DATABASE_URL"
  "CACHE_DATABASE_URL" = "SHIPSTATION_CACHE_DATABASE_URL"
  "QUEUE_DATABASE_URL" = "SHIPSTATION_QUEUE_DATABASE_URL"
  "CABLE_DATABASE_URL" = "SHIPSTATION_CABLE_DATABASE_URL"
}