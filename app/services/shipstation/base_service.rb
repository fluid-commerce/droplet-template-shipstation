module Shipstation
  # Raised when ShipStation keeps returning 429 after our bounded retries, so
  # callers can tell "rate limited" apart from a genuine empty result.
  class RateLimitError < StandardError; end

  class BaseService
    # ShipStation's V1 API base is the same host for every store; the store is
    # identified by the API key/secret, not the URL.
    SHIPSTATION_API_BASE = "https://ssapi.shipstation.com"

    def headers
      {
        "Authorization" => generate_auth_header,
        "Content-Type" => "application/json",
      }
    end

    def generate_auth_header
      credentials = Base64.encode64("#{api_key}:#{api_secret}").gsub("\n", "")
      "Basic #{credentials}"
    end

    # ShipStation V1 caps ~40 requests/minute/account and returns HTTP 429 with a
    # Retry-After / X-Rate-Limit-Reset header. GET through here so a 429 is waited
    # out and retried (bounded) rather than surfacing as a spurious failure.
    MAX_RATE_LIMIT_RETRIES = 3

    def rate_limited_get(url, query: {})
      attempts = 0
      loop do
        response = HTTParty.get(url, query: query, headers: headers)
        return response unless response.code == 429

        attempts += 1
        if attempts > MAX_RATE_LIMIT_RETRIES
          raise RateLimitError, "ShipStation rate limit exceeded after #{attempts} retries"
        end

        wait = rate_limit_wait_seconds(response)
        Rails.logger.warn("[ShipStation] 429 rate-limited; waiting #{wait}s (retry #{attempts})")
        pause(wait)
      end
    end

    def rate_limit_wait_seconds(response)
      raw = response.headers["Retry-After"] || response.headers["X-Rate-Limit-Reset"]
      seconds = raw.to_i
      seconds.positive? ? [ seconds, 60 ].min : 2
    end

    # Wrapper around sleep so tests can stub the wait.
    def pause(seconds)
      sleep(seconds)
    end
  end
end
