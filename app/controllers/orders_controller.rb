# frozen_string_literal: true

# Activity view for the embedded droplet UI: lists the orders this droplet has
# tracked for the current company and lets an admin resend one now (force-send a
# held/unpaid order, or retry a failed one). DRI-authenticated and scoped to the
# current company, mirroring the other embedded endpoints.
class OrdersController < ApplicationController
  include DriAuthenticatable

  skip_before_action :verify_authenticity_token
  before_action :require_xhr
  before_action :authenticate_dri

  RECENT_LIMIT = 100

  def index
    orders = current_company.shipstation_orders.order(created_at: :desc).limit(RECENT_LIMIT)
    render json: { orders: orders.map { |o| order_json(o) } }
  end

  # Resends an order to ShipStation immediately, bypassing the batching hold.
  # Only orders that haven't reached ShipStation yet (HELD / AWAITING_PAYMENT /
  # FAILED / PENDING) can be resent; SUBMITTED/SHIPPED are rejected.
  def resend
    order = current_company.shipstation_orders.find_by(id: params[:id])
    return render json: { error: "Not found" }, status: :not_found unless order

    unless order.sendable?
      return render json: { error: "Order is #{order.status} and cannot be resent" }, status: :unprocessable_entity
    end

    payload = { "order" => order.request_payload, "company_id" => current_company.fluid_company_id }
    Shipstation::CreateOrder.new(payload, respect_hold: false).call

    render json: order_json(order.reload)
  rescue StandardError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

private

  def require_xhr
    return if request.headers["X-Requested-With"] == "XMLHttpRequest"

    render json: { error: "Unauthorized" }, status: :unauthorized
  end

  def order_json(order)
    {
      id: order.id,
      fluid_order_number: order.fluid_order_number,
      status: order.status,
      shipstation_order_id: order.shipstation_order_id,
      tracking_numbers: order.tracking_numbers,
      carrier: order.carrier,
      last_error: order.last_error,
      hold_until: order.hold_until,
      resendable: order.sendable?,
      created_at: order.created_at,
    }
  end
end
