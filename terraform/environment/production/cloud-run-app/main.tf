# Cloud Run service module
resource "google_cloud_run_v2_service" "web_server" {
  name     = "fluid-droplet-shipstation"
  location = "europe-west1"

  deletion_protection = true

  scaling {
    min_instance_count = 1
    max_instance_count = 3
  }

  template {
    labels = {
      env : "production"
      project : "fluid-droplet-shipstation"
    }

    service_account = var.service_account_email

    vpc_access {
      network_interfaces {
        network    = "fluid-egress-vpc"
        subnetwork = "fluid-egress-vpc"
      }
      egress = "ALL_TRAFFIC"
    }


    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = ["fluid-417204:europe-west1:fluid-studioz"]
      }
    }

    containers {
      name  = "web-1"
      image = var.container_image

      ports {
        name           = "http1"
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "2Gi"
        }
        startup_cpu_boost = true
      }

      volume_mounts {
        mount_path = "/cloudsql"
        name       = "cloudsql"
      }

      dynamic "env" {
        for_each = var.environment_variables
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.environment_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 30
        failure_threshold     = 3

        period_seconds  = 30
        timeout_seconds = 240

        http_get {
          path = "/up"
          port = 3000
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true # Prevents accidental destruction
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].startup_probe,
      template[0].revision,
      client_version
    ]
  }
}

