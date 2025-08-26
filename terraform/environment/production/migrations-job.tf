module "cloud_run_job_migrations" {
  source = "../../modules/cloud_run_job"

  service_job_name = "fluid-droplet-shipstation-migrations"
  region_job       = var.region

  cloud_sql_instances_job = var.cloud_sql_instances_cloud_run
  vpc_connector_job       = var.vpc_connector_cloud_run

  image_job = var.container_image

  # Container variable values
  environment_variables_job = var.environment_variables_cloud_run

  # Resource limits
  resource_limits_job_cpu    = "1"
  resource_limits_job_memory = "512Mi"

  # Cloud Run service account
  service_account_job_email = var.email_service_account
}
