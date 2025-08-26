# Cloud Run service module
module "cloud_run_server_rails" {
  source = "../../modules/cloud_run"

  service_name = "fluid-droplet-shipstation"
  region       = "us-west3"

  environment       = "production"
  project           = "fluid-droplet-shipstation"
  purpose_cloud_run = "web"

  # Service account email
  service_account_email = var.email_service_account

  # Scaling options
  max_instances = 10
  min_instances = 1

  # VPC connector NAT
  vpc_connector = var.vpc_connector_cloud_run

  # Cloud SQL instances to connect to the database
  cloud_sql_instances = var.cloud_sql_instances_cloud_run

  # Container name
  container_name = "web-1"

  # Container variable values
  container_image = var.container_image

  # Config Cpu and Memory
  resource_limits_cpu    = "1000m"
  resource_limits_memory = "2Gi"
  # Environment variables
  environment_variables = var.environment_variables_cloud_run

}
