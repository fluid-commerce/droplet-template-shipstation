import React from 'react';
import { createRoot } from 'react-dom/client';
import { TextInput } from "../components/input/TextInput";

interface FluidProps {
  companyId: string;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  fluidApiToken: string;
}

const Fluid = ({ companyId, baseUrl, apiKey, apiSecret, fluidApiToken }: FluidProps) => {
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const data = {
      integration_setting: {
        company_id: companyId,
        api_base_url: formData.get('apiBaseUrl'),
        api_key: formData.get('apiKey'),
        api_secret: formData.get('apiSecret'),
        fluid_api_token: formData.get('fluidApiToken'),
      }
    };

    // Send form data to your endpoint
    fetch('/integration_settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
      },
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

  return (
    <div className="w-full max-w-md mx-auto">
      <form className="space-y-6" onSubmit={handleSubmit}>
        <div className="space-y-4">
          <label>
            <div className="pb-2 text-sm font-medium">
              API Base URL
            </div>
            <TextInput
              type="text"
              name="apiBaseUrl"
              placeholder="https://api.example.com"
              defaultValue={baseUrl}
            />
          </label>

          <label>
            <div className="pt-4 pb-2 text-sm font-medium">
              API Key
            </div>
            <TextInput
              type="text"
              name="apiKey"
              placeholder="API key"
              defaultValue={apiKey}
            />
          </label>

          <label>
            <div className="pt-4 pb-2 text-sm font-medium">
              API Secret
            </div>
            <TextInput
              type="password"
              name="apiSecret"
              placeholder="API secret"
              defaultValue={apiSecret}
            />
          </label>

          <label>
            <div className="pt-4 pb-2 text-sm font-medium">
              Fluid API Token
            </div>
            <TextInput
              type="password"
              name="fluidApiToken"
              placeholder="Fluid API token"
              defaultValue={fluidApiToken}
            />
          </label>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
};

const root = createRoot(document.getElementById('root') as HTMLElement);

const rootElement = document.getElementById('root') as HTMLElement;
const companyId = rootElement.dataset.companyId || '';
const baseUrl = rootElement.dataset.baseUrl || '';
const apiKey = rootElement.dataset.apiKey || '';
const apiSecret = rootElement.dataset.apiSecret || '';
const fluidApiToken = rootElement.dataset.fluidApiToken || '';

root.render(<Fluid companyId={companyId} baseUrl={baseUrl} apiKey={apiKey} apiSecret={apiSecret} fluidApiToken={fluidApiToken} />);
