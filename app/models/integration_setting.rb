# frozen_string_literal: true

class IntegrationSetting < ApplicationRecord
  belongs_to :company

  validates :company_id, presence: true
  # nil = manual-release batching (hold until an explicit send); a positive
  # window auto-releases. Zero/negative are rejected rather than silently
  # treated as manual mode.
  validates :batch_window_minutes, numericality: { greater_than: 0 }, allow_nil: true

  encrypts :settings, deterministic: true
end
