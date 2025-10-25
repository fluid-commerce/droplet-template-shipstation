# https://devcenter.heroku.com/articles/deploying-rails-applications-with-the-puma-web-server

workers Integer(ENV["WEB_CONCURRENCY"] || 2)
threads_count = Integer(ENV["RAILS_MAX_THREADS"] || 5)
threads threads_count, threads_count

preload_app!

# Support IPv6 by binding to host `::` instead of `0.0.0.0`
port(ENV["PORT"] || 3000, "::")

enable_keep_alives(false) if respond_to?(:enable_keep_alives)

rackup      DefaultRackup if defined?(DefaultRackup)
environment ENV["RACK_ENV"] || "development"

on_worker_boot do
  ActiveRecord::Base.establish_connection

  # Start the Solid Queue supervisor in the first Puma worker
  # if SOLID_QUEUE_IN_PUMA is set to true
  if ENV["SOLID_QUEUE_IN_PUMA"]
    Thread.new do
      Rails.application.executor.wrap do
        # Only start the supervisor in the first worker
        if Puma.respond_to?(:cli_config) && Puma.cli_config.options[:worker_index] == 0
          Rails.logger.info("Starting Solid Queue supervisor in Puma worker 0")
          SolidQueue::Supervisor.start
        end
      end
    rescue => e
      Rails.logger.error("Failed to start Solid Queue supervisor: #{e.message}")
      Rails.logger.error(e.backtrace.join("\n"))
    end
  end
end
