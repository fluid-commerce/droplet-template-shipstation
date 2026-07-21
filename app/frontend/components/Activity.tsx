import React, { useEffect, useState } from 'react';

interface ActivityProps {
  dri: string;
}

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

const jsonHeaders = (): HeadersInit => ({
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
});

const STATUS_STYLES: Record<string, string> = {
  SUBMITTED: 'bg-blue-100 text-blue-800',
  SHIPPED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  HELD: 'bg-amber-100 text-amber-800',
  AWAITING_PAYMENT: 'bg-amber-100 text-amber-800',
  PENDING: 'bg-gray-100 text-gray-800',
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[status] || 'bg-gray-100 text-gray-800'}`}>
    {status}
  </span>
);

const Activity: React.FC<ActivityProps> = ({ dri }) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [resending, setResending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetch(`/orders?dri=${encodeURIComponent(dri)}`, { headers: jsonHeaders() })
      .then((res) => res.json())
      .then((data) => setOrders(data.orders || []))
      .catch(() => setError('Failed to load orders'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [dri]);

  const resend = (id: number) => {
    setResending(id);
    setError(null);
    fetch(`/orders/${id}/resend`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ dri }),
    })
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d));
        return res.json();
      })
      .then((updated: Order) => setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o))))
      .catch((d) => setError(d?.error || 'Failed to resend order'))
      .finally(() => setResending(null));
  };

  return (
    <div className="w-full mt-4">
      <div className="bg-white rounded-lg p-6 border border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Order Activity</h2>
            <p className="text-sm text-gray-600">Recent orders sent to ShipStation. Resend held, unpaid, or failed orders.</p>
          </div>
          <button
            type="button"
            onClick={load}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
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
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4">Order</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">ShipStation ID</th>
                  <th className="py-2 pr-4">Tracking</th>
                  <th className="py-2 pr-4">Detail</th>
                  <th className="py-2 pr-4"></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-gray-100 align-top">
                    <td className="py-2 pr-4 font-medium text-gray-900">{o.fluid_order_number}</td>
                    <td className="py-2 pr-4"><StatusBadge status={o.status} /></td>
                    <td className="py-2 pr-4">{o.shipstation_order_id || '—'}</td>
                    <td className="py-2 pr-4">{o.tracking_numbers?.length ? o.tracking_numbers.join(', ') : '—'}</td>
                    <td className="py-2 pr-4 max-w-xs">
                      {o.last_error ? (
                        <span className="text-red-600">{o.last_error}</span>
                      ) : o.hold_until ? (
                        <span className="text-gray-500">holds until {new Date(o.hold_until).toLocaleString()}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {o.resendable && (
                        <button
                          type="button"
                          onClick={() => resend(o.id)}
                          disabled={resending === o.id}
                          className="px-3 py-1 text-sm rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
                        >
                          {resending === o.id ? 'Sending…' : 'Send now'}
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
};

export default Activity;
