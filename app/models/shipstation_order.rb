# frozen_string_literal: true

class ShipstationOrder < ApplicationRecord
  belongs_to :company

  STATUSES = %w[PENDING SUBMITTED SHIPPED FAILED AWAITING_PAYMENT].freeze
  SENDABLE_STATUSES = %w[FAILED AWAITING_PAYMENT PENDING].freeze

  validates :fluid_order_id, presence: true
  validates :fluid_order_number, presence: true
  validates :status, presence: true, inclusion: { in: STATUSES }

  scope :needs_tracking_sync, -> {
    where(status: "SHIPPED", tracking_synced_to_fluid: false)
      .where.not(tracking_numbers: [])
      .where(created_at: 30.days.ago..)
  }

  scope :failed, -> { where(status: "FAILED") }

  def sendable?
    SENDABLE_STATUSES.include?(status)
  end
end
