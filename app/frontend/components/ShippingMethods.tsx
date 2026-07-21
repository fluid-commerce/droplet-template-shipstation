import React, { useEffect, useState } from 'react';
import { TextInput } from "./input/TextInput";

interface ShippingMethodsProps {
  dri: string;
}

interface Mapping {
  id: number;
  fluid_shipping_title: string;
  carrier_code: string | null;
  service_code: string | null;
  package_code: string | null;
  description: string | null;
}

interface Unmapped {
  fluid_shipping_title: string;
  seen_count: number;
  last_seen_at: string;
  example_order_number: string | null;
}

// The DRI authenticates and scopes the request server-side; X-Requested-With
// guards against cross-origin form posts (Rails CSRF token verification is
// skipped on these endpoints).
const jsonHeaders = (): HeadersInit => ({
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
});

const emptyForm = {
  fluid_shipping_title: '',
  carrier_code: '',
  service_code: '',
  package_code: '',
  description: '',
};

const ShippingMethods: React.FC<ShippingMethodsProps> = ({ dri }) => {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [unmapped, setUnmapped] = useState<Unmapped[]>([]);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetch(`/shipping_method_mappings?dri=${encodeURIComponent(dri)}`, {
      headers: jsonHeaders(),
    })
      .then((res) => res.json())
      .then((data) => {
        setMappings(data.mappings || []);
        setUnmapped(data.unmapped || []);
      })
      .catch(() => setError('Failed to load shipping methods'));
  };

  useEffect(load, [dri]);

  const setField = (key: keyof typeof emptyForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.fluid_shipping_title.trim()) {
      setError('Shipping method title is required');
      return;
    }
    setSaving(true);
    setError(null);
    fetch('/shipping_method_mappings', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ dri, shipping_method_mapping: form }),
    })
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d));
        setForm({ ...emptyForm });
        load();
      })
      .catch((d) => setError((d?.errors || ['Error saving mapping']).join(', ')))
      .finally(() => setSaving(false));
  };

  const handleDelete = (id: number) => {
    fetch(`/shipping_method_mappings/${id}?dri=${encodeURIComponent(dri)}`, {
      method: 'DELETE',
      headers: jsonHeaders(),
    }).then(load);
  };

  const mapUnmapped = (title: string) => {
    setForm({ ...emptyForm, fluid_shipping_title: title });
  };

  return (
    <div className="w-full mt-4 space-y-8">
      <div className="bg-white rounded-lg p-6 border border-gray-200">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Shipping Method Mappings</h2>
          <p className="text-sm text-gray-600">
            Map a Fluid shipping method to the ShipStation carrier, service, and package codes
            requested when the order is created.
          </p>
        </div>

        {unmapped.length > 0 && (
          <div className="mb-6 rounded-md bg-amber-50 border border-amber-200 p-4">
            <p className="text-sm font-medium text-amber-800 mb-2">
              Seen on orders but not yet mapped:
            </p>
            <div className="flex flex-wrap gap-2">
              {unmapped.map((u) => (
                <button
                  key={u.fluid_shipping_title}
                  type="button"
                  onClick={() => mapUnmapped(u.fluid_shipping_title)}
                  className="px-3 py-1 text-sm rounded-full bg-white border border-amber-300 text-amber-900 hover:bg-amber-100"
                  title={`Seen ${u.seen_count}× (e.g. order ${u.example_order_number || 'n/a'})`}
                >
                  {u.fluid_shipping_title} ({u.seen_count})
                </button>
              ))}
            </div>
          </div>
        )}

        {mappings.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4">Fluid Title</th>
                  <th className="py-2 pr-4">Carrier</th>
                  <th className="py-2 pr-4">Service</th>
                  <th className="py-2 pr-4">Package</th>
                  <th className="py-2 pr-4"></th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.id} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium text-gray-900">{m.fluid_shipping_title}</td>
                    <td className="py-2 pr-4">{m.carrier_code || '—'}</td>
                    <td className="py-2 pr-4">{m.service_code || '—'}</td>
                    <td className="py-2 pr-4">{m.package_code || '—'}</td>
                    <td className="py-2 pr-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(m.id)}
                        className="text-red-600 hover:text-red-800"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-gray-500">No mappings configured yet.</p>
        )}
      </div>

      <form className="bg-white rounded-lg p-6 border border-gray-200 space-y-4" onSubmit={handleSave}>
        <h3 className="text-md font-semibold text-gray-900">Add / Update Mapping</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextInput
            label="Fluid Shipping Title*"
            placeholder="Ground Shipping"
            value={form.fluid_shipping_title}
            onChange={setField('fluid_shipping_title')}
          />
          <TextInput
            label="Carrier Code"
            placeholder="stamps_com"
            value={form.carrier_code}
            onChange={setField('carrier_code')}
          />
          <TextInput
            label="Service Code"
            placeholder="usps_priority_mail"
            value={form.service_code}
            onChange={setField('service_code')}
          />
          <TextInput
            label="Package Code"
            placeholder="package"
            value={form.package_code}
            onChange={setField('package_code')}
          />
          <TextInput
            label="Description"
            placeholder="Optional note"
            value={form.description}
            onChange={setField('description')}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Mapping'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ShippingMethods;
