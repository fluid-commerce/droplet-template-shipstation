"use client";

/**
 * Port of app/frontend/components/ConfigurationForm.tsx.
 *
 * Credentials are write-only from the browser: stored values are never sent to
 * the client (the server only says *whether* each is set), and a blank field
 * means "keep the saved secret". See src/lib/integration-settings.ts.
 */

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import { jsonHeaders, withDri } from "./api";
import { ConnectionStatusButton, type ConnectionStatus } from "./connection-status-button";
import { TextInput } from "./text-input";

export interface ConfigurationFormProps {
  dri: string;
  apiKeySet: boolean;
  apiSecretSet: boolean;
  holdForBatch: boolean;
  batchWindowMinutes: string;
  apiVersion: string;
  v2ApiKeySet: boolean;
  v2Sandbox: boolean;
  storeId: string;
}

interface Store {
  id: string;
  name: string;
  marketplace: string | null;
}

type V2TestState = { status: ConnectionStatus; sandbox: boolean };

export function ConfigurationForm({
  dri,
  apiKeySet,
  apiSecretSet,
  holdForBatch,
  batchWindowMinutes,
  apiVersion,
  v2ApiKeySet,
  v2Sandbox,
  storeId,
}: ConfigurationFormProps) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("default");
  const [batchEnabled, setBatchEnabled] = useState(holdForBatch);
  const [version, setVersion] = useState(apiVersion === "v2" ? "v2" : "v1");
  const [v2Key, setV2Key] = useState("");
  const [v2Test, setV2Test] = useState<V2TestState>({ status: "default", sandbox: false });
  const [store, setStore] = useState(storeId || "");
  const [stores, setStores] = useState<Store[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // The sandbox badge reflects a typed TEST_ key or, before typing, the stored
  // key's sandbox flag from the server.
  const isSandboxKey = v2Key ? v2Key.startsWith("TEST_") : v2ApiKeySet && v2Sandbox;
  const savedPlaceholder = (isSet: boolean, hint: string) =>
    isSet ? "•••••••• (saved — leave blank to keep)" : hint;

  // Load the connected account's stores so orders can be assigned to one.
  // Best-effort: on failure the dropdown is empty and the saved value stands.
  useEffect(() => {
    fetch(withDri("/api/shipping-catalog/stores", dri), { headers: jsonHeaders() })
      .then((res) => (res.ok ? res.json() : { stores: [] }))
      .then((data) => setStores(data.stores || []))
      .catch(() => setStores([]));
  }, [dri]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    // Only send a secret when the user actually entered a new value; a blank
    // field means "keep the stored secret" (the server preserves it).
    const setting: Record<string, unknown> = {
      hold_for_batch: batchEnabled,
      batch_window_minutes: formData.get("batchWindowMinutes") || "",
      api_version: version,
      store_id: store,
    };
    const apiKey = String(formData.get("apiKey") ?? "").trim();
    const apiSecret = String(formData.get("apiSecret") ?? "").trim();
    if (apiKey) setting.api_key = apiKey;
    if (apiSecret) setting.api_secret = apiSecret;
    if (v2Key.trim()) setting.v2_api_key = v2Key.trim();

    fetch("/api/integration-settings", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ dri, integration_setting: setting }),
    })
      .then((response) =>
        setMessage(
          response.ok ? "Configuration saved." : "Error saving configuration.",
        ),
      )
      .catch(() => setMessage("Error saving configuration."));
  };

  const handleTestConnection = () => {
    setConnectionStatus("connecting");
    fetch("/api/integration-settings/test-connection", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ dri }),
    })
      .then((response) => response.json())
      .then((data) => setConnectionStatus(data.connection ? "connected" : "error"))
      .catch(() => setConnectionStatus("error"));
  };

  // Testing a V2 key as entered (not yet saved) is not supported server-side —
  // the endpoint reads the stored key, so save first, then test.
  const handleTestV2Connection = () => {
    setV2Test({ status: "connecting", sandbox: false });
    fetch("/api/integration-settings/test-v2-connection", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ dri }),
    })
      .then((response) => response.json())
      .then((data) =>
        setV2Test({
          status: data.connected ? "connected" : "error",
          sandbox: !!data.sandbox,
        }),
      )
      .catch(() => setV2Test({ status: "error", sandbox: false }));
  };

  return (
    <div className="mt-4 w-full">
      <form className="space-y-8" onSubmit={handleSubmit}>
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">API Credentials</h2>
            <p className="text-sm text-gray-600">
              Enter your ShipStation V1 API key and secret. Stored credentials are never
              shown again — leave a field blank to keep the saved value, or type a new one
              to replace it.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                API Key{apiKeySet ? "" : "*"}
              </label>
              <TextInput
                type="text"
                name="apiKey"
                autoComplete="off"
                placeholder={savedPlaceholder(apiKeySet, "Username")}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                API Secret{apiSecretSet ? "" : "*"}
              </label>
              <TextInput
                type="password"
                name="apiSecret"
                autoComplete="new-password"
                placeholder={savedPlaceholder(apiSecretSet, "Password")}
              />
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">API Version</h2>
            <p className="text-sm text-gray-600">
              V1 uses the API Key/Secret above. V2 (ShipStation/ShipEngine) uses a single
              API Key and supports a sandbox environment (keys beginning with{" "}
              <code>TEST_</code>).
            </p>
          </div>

          <div className="mb-4 max-w-xs">
            <label className="mb-1 block text-sm font-medium text-gray-700">
              API version
            </label>
            <select
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              className="block w-full rounded-md border-0 px-3 py-2 text-gray-900 shadow-xs ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm"
            >
              <option value="v1">V1 (ssapi.shipstation.com)</option>
              <option value="v2">V2 (api.shipstation.com — sandbox capable)</option>
            </select>
          </div>

          {version === "v2" && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                V2 API Key
                {isSandboxKey && (
                  <span className="ml-2 rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800">
                    Sandbox
                  </span>
                )}
              </label>
              <TextInput
                type="password"
                name="v2ApiKey"
                autoComplete="new-password"
                placeholder={savedPlaceholder(
                  v2ApiKeySet,
                  "Production key, or TEST_… for sandbox",
                )}
                value={v2Key}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setV2Key(event.target.value)
                }
              />
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleTestV2Connection}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Test V2 Connection
                </button>
                {v2Test.status === "connecting" && (
                  <span className="text-sm text-blue-700">Testing…</span>
                )}
                {v2Test.status === "connected" && (
                  <span className="text-sm text-green-700">
                    Connected{v2Test.sandbox ? " (sandbox)" : ""}
                  </span>
                )}
                {v2Test.status === "error" && (
                  <span className="text-sm text-red-700">Not connected</span>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Save first — the test reads the stored key.
              </p>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Store Assignment</h2>
            <p className="text-sm text-gray-600">
              Which ShipStation store new orders are created in. Leave as the default to
              use the store tied to your API key. Marketplace stores (Shopify,
              WooCommerce) are shown but typically sync from their own source — a
              manual/custom store is usually the safer target.
            </p>
          </div>

          <div className="max-w-md">
            <label className="mb-1 block text-sm font-medium text-gray-700">Store</label>
            <select
              value={store}
              onChange={(event) => setStore(event.target.value)}
              className="block w-full rounded-md border-0 px-3 py-2 text-gray-900 shadow-xs ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm"
            >
              <option value="">Default (store for API key)</option>
              {stores.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {option.marketplace ? ` — ${option.marketplace}` : ""}
                </option>
              ))}
              {/* Preserve a saved store that isn't in the fetched list (e.g. inactive). */}
              {store && !stores.some((option) => option.id === store) && (
                <option value={store}>Saved store #{store}</option>
              )}
            </select>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Order Batching</h2>
            <p className="text-sm text-gray-600">
              Hold new orders instead of sending them to ShipStation immediately. Held
              orders are released automatically after the batch window, or manually.
            </p>
          </div>

          <label className="mb-4 flex items-center gap-2">
            <input
              type="checkbox"
              checked={batchEnabled}
              onChange={(event) => setBatchEnabled(event.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm font-medium text-gray-700">
              Hold orders for batching
            </span>
          </label>

          <div className="max-w-xs">
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Batch window (minutes)
            </label>
            <TextInput
              type="number"
              name="batchWindowMinutes"
              placeholder="Leave blank for manual release only"
              min="0"
              defaultValue={batchWindowMinutes}
              disabled={!batchEnabled}
            />
            <p className="mt-1 text-xs text-gray-500">
              Blank = hold until released manually. Otherwise orders auto-release this
              many minutes after they arrive.
            </p>
          </div>
        </section>

        {message && <p className="text-sm text-gray-700">{message}</p>}

        <div className="flex justify-between gap-3">
          <ConnectionStatusButton status={connectionStatus} />

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleTestConnection}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Test Connection
            </button>
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Save
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
