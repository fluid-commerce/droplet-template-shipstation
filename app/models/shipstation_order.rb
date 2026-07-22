# frozen_string_literal: true

class ShipstationOrder < ApplicationRecord
  belongs_to :company

  STATUSES = %w[PENDING SUBMITTED SHIPPED FAILED AWAITING_PAYMENT HELD CANCELLED].freeze
  SENDABLE_STATUSES = %w[FAILED AWAITING_PAYMENT PENDING HELD].freeze
  # Statuses an admin can manually resend from the Activity tab. Excludes
  # AWAITING_PAYMENT (respect_hold:false doesn't bypass the payment gate, so a
  # resend would silently re-hold) and terminal CANCELLED/SUBMITTED/SHIPPED.
  RESENDABLE_STATUSES = %w[FAILED PENDING HELD].freeze

  validates :fluid_order_id, presence: true
  validates :fluid_order_number, presence: true
  validates :status, presence: true, inclusion: { in: STATUSES }

  scope :needs_tracking_sync, -> {
    where(status: "SHIPPED", tracking_synced_to_fluid: false)
      .where.not(tracking_numbers: [])
      .where(created_at: 30.days.ago..)
  }

  # Orders sent to ShipStation but not yet known to have shipped. The poll job
  # queries ShipStation for these (ShipStation pushes no shipment webhook to us)
  # to discover tracking. Bounded to 30 days so old stragglers stop being polled.
  scope :pollable_for_tracking, -> {
    where(status: "SUBMITTED")
      .where.not(shipstation_order_id: [ nil, "" ])
      .where(created_at: 30.days.ago..)
  }

  scope :failed, -> { where(status: "FAILED") }
  scope :awaiting_payment, -> { where(status: "AWAITING_PAYMENT") }
  scope :held, -> { where(status: "HELD") }

  # HELD orders whose batch window has elapsed and are due to be flushed. Orders
  # held with no hold_until (manual-release batching) are excluded — they wait
  # for an explicit release.
  scope :releasable_for_batch, -> {
    held.where.not(hold_until: nil).where(hold_until: ..Time.current)
  }

  def sendable?
    SENDABLE_STATUSES.include?(status)
  end

  def resendable?
    RESENDABLE_STATUSES.include?(status)
  end
end
