"use client";

/** Port of app/frontend/entrypoints/home.tsx — the three-tab embedded UI. */

import { useState } from "react";

import { Activity } from "./activity";
import { ConfigurationForm, type ConfigurationFormProps } from "./configuration-form";
import { ShippingMethods } from "./shipping-methods";

const TABS = [
  { id: "configuration", label: "Configuration" },
  { id: "shipping-methods", label: "Shipping Methods" },
  { id: "activity", label: "Activity" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function DropletUi(props: ConfigurationFormProps) {
  const [activeTab, setActiveTab] = useState<TabId>("configuration");

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex space-x-8">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`border-b-2 px-1 py-2 text-sm font-medium ${
                    activeTab === tab.id
                      ? "border-gray-900 text-gray-900"
                      : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {activeTab === "configuration" && <ConfigurationForm {...props} />}
          {activeTab === "shipping-methods" && <ShippingMethods dri={props.dri} />}
          {activeTab === "activity" && <Activity dri={props.dri} />}
        </div>
      </div>
    </div>
  );
}
