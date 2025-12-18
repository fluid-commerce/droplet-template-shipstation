terraform {
  required_version = "1.13.5"

  backend "gcs" {
    bucket = "fluid-terraform"
    prefix = "fluid-droplet-shipstation/cloud-run-app"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~>7.14.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
