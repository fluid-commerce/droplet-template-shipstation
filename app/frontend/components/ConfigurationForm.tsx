import React, { useState } from 'react';
import { TextInput } from "./input/TextInput";
import ConnectionStatusButton from './ConnectionStatusButton';

interface ConfigurationFormProps {
  dri: string;
  apiKey: string;
  apiSecret: string;
  holdForBatch: boolean;
  batchWindowMinutes: string;
}

type ConnectionStatus = 'default' | 'connecting' | 'connected' | 'error';

// Headers for authenticated, same-origin JSON requests. The DRI authenticates
// and scopes the request server-side; X-Requested-With guards against
// cross-origin form posts now that Rails CSRF token verification is skipped.
const jsonHeaders = (): HeadersInit => ({
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
});

const ConfigurationForm: React.FC<ConfigurationFormProps> = ({ dri, apiKey, apiSecret, holdForBatch, batchWindowMinutes }) => {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('default');
  const [batchEnabled, setBatchEnabled] = useState<boolean>(holdForBatch);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const data = {
      dri,
      integration_setting: {
        api_key: formData.get('apiKey'),
        api_secret: formData.get('apiSecret'),
        hold_for_batch: batchEnabled,
        batch_window_minutes: formData.get('batchWindowMinutes') || '',
      }
    };

    // Send form data to your endpoint
    fetch('/integration_settings', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(data),
    })
    .then(response => {
      if (response.ok) {
        alert('Configuration saved successfully!');
      } else {
        alert('Error saving configuration');
      }
    })
    .catch(error => {
      console.error('Error:', error);
      alert('Error saving configuration');
    });
  };

  const handleTestConnection = () => {
    setConnectionStatus('connecting');

    fetch('/integration_settings/test_connection', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ dri }),
    })
    .then(response => response.json())
    .then(data => {
      if (data.connection) {
        setConnectionStatus('connected');
      } else {
        setConnectionStatus('error');
      }
    })
    .catch(error => {
      console.error('Error:', error);
      setConnectionStatus('error');
    });
  };

  return (
    <div className="w-full mt-4">
      <form className="space-y-8" onSubmit={handleSubmit}>
        <div className="bg-white rounded-lg p-6 border border-gray-200">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">API Credentials</h2>
            <p className="text-sm text-gray-600">Configure your API connection settings</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                API Key*
              </label>
              <TextInput
                type="text"
                name="apiKey"
                placeholder="Username"
                defaultValue={apiKey}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                API Secret*
              </label>
              <TextInput
                type="password"
                name="apiSecret"
                placeholder="Password"
                defaultValue={apiSecret}
              />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg p-6 border border-gray-200">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Order Batching</h2>
            <p className="text-sm text-gray-600">
              Hold new orders instead of sending them to ShipStation immediately. Held orders are
              released automatically after the batch window, or manually.
            </p>
          </div>

          <label className="flex items-center gap-2 mb-4">
            <input
              type="checkbox"
              checked={batchEnabled}
              onChange={(e) => setBatchEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm font-medium text-gray-700">Hold orders for batching</span>
          </label>

          <div className="max-w-xs">
            <label className="block text-sm font-medium text-gray-700 mb-1">
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
              Blank = hold until released manually. Otherwise orders auto-release this many minutes
              after they arrive.
            </p>
          </div>
        </div>

        <div className="flex justify-between gap-3">
          <ConnectionStatusButton status={connectionStatus} />

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleTestConnection}
              className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Test Connection
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

export default ConfigurationForm;
