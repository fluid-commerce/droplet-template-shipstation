## README

Droplets are integrations between third-party services and Fluid. This is a repository intended to be used as an example for creating Droplets.

Documentation can be found in the [project's GitHub page](https://fluid-commerce.github.io/droplet-template/)

## Production environment

### Google cloud infrastructure

- Google Cloud Run (Web)
- Google Cloud Storage (Terraform)
- Google Cloud SQL (postgreSQL)
- Google Cloud Build (CI/CD)
- Google Cloud Compute Engine (jobs console)
- Artifact Registry (Docker)

web: Google Cloud Run name `fluid-droplet-NAME`

jobs console: Google Cloud Compute Engine name `fluid-droplet-NAME-jobs-console`

### Deploy to google cloud

Run github action to deploy to google cloud `deploy production`
or run the following command to deploy to google cloud  

`gcloud beta builds submit --config cloudbuild-production.yml --region=us-west3 --substitutions=COMMIT_SHA=$(git rev-parse --short HEAD),_TIMESTAMP=$(date +%Y%m%d%H%M%S) --project=fluid-417204 .`

### Add environment variables to google cloud

Add environment variables to google cloud `add-update-env-gcloud.sh` and run the following command to add environment variables to google cloud
`sh add-update-env-gcloud.sh`

### Sentry Configuration

This project includes Sentry integration for error monitoring and performance tracking. To enable Sentry:

1. **Create a Sentry project:**
   - Go to [Sentry.io](https://sentry.io) and create a new project
   - Select "Ruby" as the platform
   - Copy the DSN from your project settings

2. **Set the environment variable:**
   - Add `SENTRY_DSN` to your environment variables with the DSN from your Sentry project
   - For local development, add it to your `.env` file:
     ```bash
     SENTRY_DSN=https://your-dsn@sentry.io/project-id
     ```
   - For production, add it to your Google Cloud environment variables

3. **Sentry features enabled:**
   - Automatic error tracking and reporting
   - Performance monitoring
   - Request headers and IP data collection (for debugging)
   - Active Support and HTTP logger breadcrumbs

The Sentry integration will only be active when the `SENTRY_DSN` environment variable is present and configured.

### Technology Stack

![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-336791?logo=postgresql&logoColor=white)
![Ruby](https://img.shields.io/badge/Ruby-3.4.2-CC342D?logo=ruby&logoColor=white)
![Rails](https://img.shields.io/badge/Rails-8.0.2-CC0000?logo=ruby-on-rails&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-23.8.0-339933?logo=node.js&logoColor=white)
![Yarn](https://img.shields.io/badge/Yarn-4.7.0-2C8EBB?logo=yarn&logoColor=white)
![Font Awesome](https://img.shields.io/badge/Font_Awesome-6.7.2-528DD7?logo=fontawesome&logoColor=white)
![Tailwind CSS 4.0](https://img.shields.io/badge/Tailwind_CSS-4.0-38B2AC?logo=tailwindcss&logoColor=white)
<br>

## Local environment

### Running locally

Install dependencies with `bundle install` and `yarn install`
and install foreman with `gem install foreman`  
Just the rails server (port 3000)<br>
`foreman start -f Procfile.dev`

Running everything (port 3200)<br>
`bin/dev`

### Running locally with docker

Configure your environment variables in `.env` file
and run the following command:  
`make install`
Running it as a docker service (port 3600)<br>
`make up`

Run `make help` to see all commands

### License

MIT License

Copyright (c) 2025 Fluid Commerce

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
