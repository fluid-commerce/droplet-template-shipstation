# frozen_string_literal: true

class IntegrationSetting < ApplicationRecord
  belongs_to :company

  API_VERSIONS = %w[v1 v2].freeze

  validates :company_id, presence: true
  # nil = manual-release batching (hold until an explicit send); a positive
  # window auto-releases. Zero/negative are rejected rather than silently
  # treated as manual mode.
  validates :batch_window_minutes, numericality: { greater_than: 0 }, allow_nil: true
  validates :api_version, inclusion: { in: API_VERSIONS }

  encrypts :settings, deterministic: true

  def v2?
    api_version == "v2"
  end

  def v2_api_key
    settings["v2_api_key"]
  end

  # ShipStation V2/ShipEngine sandbox keys are prefixed "TEST_".
  def sandbox?
    v2_api_key.to_s.start_with?("TEST_")
  end
end
