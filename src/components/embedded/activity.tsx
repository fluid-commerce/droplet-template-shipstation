"use client";

/**
 * Port of app/frontend/components/Activity.tsx.
 *
 * Recent orders this droplet has tracked, and a "Send now" for the ones that
 * can safely be re-sent. Which those are is decided server-side — see
 * RESENDABLE_STATUSES in src/lib/orders.ts — so a stale page cannot resend an
 * order that has since shipped.
 */

import { useCallback, useEffect, useState } from "react";

import { jsonHeaders, withDri } from "./api";

interface Order {
  id: number;
  fluid_order_number: string;
  status: string;
  shipstation_order_id: string | null;
  tracking_numbers: string[];
  carrier: string | null;
  last_error: string | null;
  hold_until: string | null;
  resendable: boolean;
  created_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  SUBMITTED: "bg-blue-100 text-blue-800",
  SHIPPED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
  HELD: "bg-amber-100 text-amber-800",
  AWAITING_PAYMENT: "bg-amber-100 text-amber-800",
  PENDING: "bg-gray-100 text-gray-800",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        STATUS_STYLES[status] || "bg-gray-100 text-gray-800"
      }`}
    >
      {status}
    </span>
  );
}

export function Activity({ dri }: { dri: string }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [resending, setResending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(withDri("/api/orders", dri), { headers: jsonHeaders() })
      .then((res) => res.json())
      .then((data) => setOrders(data.orders || []))
      .catch(() => setError("Failed to load orders"))
      .finally(() => setLoading(false));
  }, [dri]);

  useEffect(load, [load]);

  const resend = (id: number) => {
    setResending(id);
    setError(null);
    fetch(`/api/orders/${id}/resend`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ dri }),
    })
      .then((res) => {
        if (!res.ok) return res.json().then((data) => Promise.reject(data));
        return res.json();
      })
      .then((updated: Order) =>
        setOrders((previous) =>
          previous.map((order) => (order.id === updated.id ? updated : order)),
        ),
      )
      .catch((data) => setError(data?.error || "Failed to resend order"))
      .finally(() => setResending(null));
  };

  return (
    <div className="mt-4 w-full">
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Order Activity</h2>
            <p className="text-sm text-gray-600">
              Recent orders sent to ShipStation. Resend held, unpaid, or failed orders.
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : orders.length === 0 ? (
          <p className="text-sm text-gray-500">No orders yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="py-2 pr-4">Order</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">ShipStation ID</th>
                  <th className="py-2 pr-4">Tracking</th>
                  <th className="py-2 pr-4">Detail</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-gray-100 align-top">
                    <td className="py-2 pr-4 font-medium text-gray-900">
                      {order.fluid_order_number}
                    </td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={order.status} />
                    </td>
                    <td className="py-2 pr-4">{order.shipstation_order_id || "—"}</td>
                    <td className="py-2 pr-4">
                      {order.tracking_numbers?.length
                        ? order.tracking_numbers.join(", ")
                        : "—"}
                    </td>
                    <td className="max-w-xs py-2 pr-4">
                      {order.last_error ? (
                        <span className="text-red-600">{order.last_error}</span>
                      ) : order.hold_until ? (
                        <span className="text-gray-500">
                          holds until {new Date(order.hold_until).toLocaleString()}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {order.resendable && (
                        <button
                          type="button"
                          onClick={() => resend(order.id)}
                          disabled={resending === order.id}
                          className="rounded-md bg-gray-900 px-3 py-1 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
                        >
                          {resending === order.id ? "Sending…" : "Send now"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
