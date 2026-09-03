"use client";

/**
 * Port of app/frontend/components/ShippingMethods.tsx.
 *
 * Maps a Fluid shipping method title to the ShipStation carrier/service/package
 * codes requested when the order is pushed. The dropdowns are fed by a backend
 * proxy so the ShipStation credentials never reach the browser.
 */

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import { jsonHeaders, withDri } from "./api";
import { TextInput } from "./text-input";

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

interface CodeName {
  code: string;
  name: string;
}

const emptyForm = {
  fluid_shipping_title: "",
  carrier_code: "",
  service_code: "",
  package_code: "",
  description: "",
};

export function ShippingMethods({ dri }: { dri: string }) {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [unmapped, setUnmapped] = useState<Unmapped[]>([]);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Catalog suggestions for the dropdowns (best-effort; empty = manual entry).
  const [carriers, setCarriers] = useState<CodeName[]>([]);
  const [services, setServices] = useState<CodeName[]>([]);
  const [packages, setPackages] = useState<CodeName[]>([]);
  const [titles, setTitles] = useState<string[]>([]);

  const load = useCallback(() => {
    fetch(withDri("/api/shipping-method-mappings", dri), { headers: jsonHeaders() })
      .then((res) => res.json())
      .then((data) => {
        setMappings(data.mappings || []);
        setUnmapped(data.unmapped || []);
      })
      .catch(() => setError("Failed to load shipping methods"));
  }, [dri]);

  const catalog = useCallback(
    (path: string): Promise<Record<string, never[]>> =>
      fetch(withDri(`/api/shipping-catalog/${path}`, dri), { headers: jsonHeaders() })
        .then((res) => (res.ok ? res.json() : {}))
        .catch(() => ({})),
    [dri],
  );

  // Services and packages are scoped to a carrier in ShipStation, so they load
  // per carrier and clear when none is chosen.
  const loadCarrierChildren = (carrierCode: string) => {
    if (!carrierCode) {
      setServices([]);
      setPackages([]);
      return;
    }
    const code = encodeURIComponent(carrierCode);
    catalog(`services?carrier_code=${code}`).then((data) => setServices(data.services || []));
    catalog(`packages?carrier_code=${code}`).then((data) => setPackages(data.packages || []));
  };

  useEffect(() => {
    load();
    catalog("carriers").then((data) => setCarriers(data.carriers || []));
    catalog("fluid-methods").then((data) => setTitles(data.titles || []));
  }, [load, catalog]);

  const setField =
    (key: keyof typeof emptyForm) => (event: ChangeEvent<HTMLInputElement>) =>
      setForm((previous) => ({ ...previous, [key]: event.target.value }));

  // Changing the carrier reloads its services/packages and clears the previous
  // selections, which belonged to the old carrier.
  const setCarrier = (event: ChangeEvent<HTMLInputElement>) => {
    const carrier_code = event.target.value;
    setForm((previous) => ({ ...previous, carrier_code, service_code: "", package_code: "" }));
    loadCarrierChildren(carrier_code);
  };

  const handleSave = (event: FormEvent) => {
    event.preventDefault();

    if (!form.fluid_shipping_title.trim()) {
      setError("Shipping method title is required");
      return;
    }
    // ShipStation rejects a carrier without a service ("Invalid serviceCode"),
    // so require the pair up front rather than letting the order push fail later.
    if (form.carrier_code.trim() && !form.service_code.trim()) {
      setError(
        "Service Code is required when a Carrier Code is set (ShipStation rejects a carrier without a service).",
      );
      return;
    }

    setSaving(true);
    setError(null);
    fetch("/api/shipping-method-mappings", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ dri, shipping_method_mapping: form }),
    })
      .then((res) => {
        if (!res.ok) return res.json().then((data) => Promise.reject(data));
        setForm({ ...emptyForm });
        load();
      })
      .catch((data) => setError((data?.errors || ["Error saving mapping"]).join(", ")))
      .finally(() => setSaving(false));
  };

  const handleDelete = (id: number) => {
    fetch(withDri(`/api/shipping-method-mappings/${id}`, dri), {
      method: "DELETE",
      headers: jsonHeaders(),
    }).then(load);
  };

  return (
    <div className="mt-4 w-full space-y-8">
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Shipping Method Mappings</h2>
          <p className="text-sm text-gray-600">
            Map a Fluid shipping method to the ShipStation carrier, service, and package
            codes requested when the order is created.
          </p>
        </div>

        {unmapped.length > 0 && (
          <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="mb-2 text-sm font-medium text-amber-800">
              Seen on orders but not yet mapped:
            </p>
            <div className="flex flex-wrap gap-2">
              {unmapped.map((row) => (
                <button
                  key={row.fluid_shipping_title}
                  type="button"
                  onClick={() =>
                    setForm({ ...emptyForm, fluid_shipping_title: row.fluid_shipping_title })
                  }
                  className="rounded-full border border-amber-300 bg-white px-3 py-1 text-sm text-amber-900 hover:bg-amber-100"
                  title={`Seen ${row.seen_count}× (e.g. order ${row.example_order_number || "n/a"})`}
                >
                  {row.fluid_shipping_title} ({row.seen_count})
                </button>
              ))}
            </div>
          </div>
        )}

        {mappings.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="py-2 pr-4">Fluid Title</th>
                  <th className="py-2 pr-4">Carrier</th>
                  <th className="py-2 pr-4">Service</th>
                  <th className="py-2 pr-4">Package</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping) => (
                  <tr key={mapping.id} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium text-gray-900">
                      {mapping.fluid_shipping_title}
                    </td>
                    <td className="py-2 pr-4">{mapping.carrier_code || "—"}</td>
                    <td className="py-2 pr-4">{mapping.service_code || "—"}</td>
                    <td className="py-2 pr-4">{mapping.package_code || "—"}</td>
                    <td className="py-2 pr-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(mapping.id)}
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

      <form
        className="space-y-4 rounded-lg border border-gray-200 bg-white p-6"
        onSubmit={handleSave}
      >
        <h3 className="text-md font-semibold text-gray-900">Add / Update Mapping</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextInput
            label="Fluid Shipping Title*"
            placeholder="Ground Shipping"
            list="fluid-titles-list"
            value={form.fluid_shipping_title}
            onChange={setField("fluid_shipping_title")}
          />
          <TextInput
            label="Carrier Code"
            placeholder="stamps_com"
            list="carriers-list"
            value={form.carrier_code}
            onChange={setCarrier}
          />
          <TextInput
            label={form.carrier_code.trim() ? "Service Code*" : "Service Code"}
            placeholder="usps_priority_mail"
            list="services-list"
            value={form.service_code}
            onChange={setField("service_code")}
          />
          <TextInput
            label="Package Code"
            placeholder="package"
            list="packages-list"
            value={form.package_code}
            onChange={setField("package_code")}
          />
          <TextInput
            label="Description"
            placeholder="Optional note"
            value={form.description}
            onChange={setField("description")}
          />
        </div>

        {/* Datalists suggest values from the connected ShipStation account and
            Fluid, while still allowing a custom value to be typed. */}
        <datalist id="fluid-titles-list">
          {titles.map((title) => (
            <option key={title} value={title} />
          ))}
        </datalist>
        <datalist id="carriers-list">
          {carriers.map((carrier) => (
            <option key={carrier.code} value={carrier.code}>
              {carrier.name}
            </option>
          ))}
        </datalist>
        <datalist id="services-list">
          {services.map((service) => (
            <option key={service.code} value={service.code}>
              {service.name}
            </option>
          ))}
        </datalist>
        <datalist id="packages-list">
          {packages.map((pkg) => (
            <option key={pkg.code} value={pkg.code}>
              {pkg.name}
            </option>
          ))}
        </datalist>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Mapping"}
          </button>
        </div>
      </form>
    </div>
  );
}
