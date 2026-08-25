"use client";

/** Port of app/frontend/components/ConnectionStatusButton.tsx. */

export type ConnectionStatus = "default" | "connecting" | "connected" | "error";

const BASE =
  "px-4 py-2 border rounded-md shadow-sm text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-2";

const CONFIG: Record<ConnectionStatus, { text: string; className: string }> = {
  connecting: {
    text: "Establishing Connection",
    className: `${BASE} border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 focus:ring-blue-500`,
  },
  connected: {
    text: "Connected",
    className: `${BASE} border-green-300 text-green-700 bg-green-50 hover:bg-green-100 focus:ring-green-500`,
  },
  error: {
    text: "Not Connected",
    className: `${BASE} border-red-300 text-red-700 bg-red-50 hover:bg-red-100 focus:ring-red-500`,
  },
  default: {
    text: "Connection Status",
    className: `${BASE} border-gray-300 text-gray-700 bg-white hover:bg-gray-50 focus:ring-blue-500`,
  },
};

export function ConnectionStatusButton({
  status,
  disabled = false,
}: {
  status: ConnectionStatus;
  disabled?: boolean;
}) {
  const config = CONFIG[status];

  return (
    <button
      type="button"
      disabled={disabled || status === "connecting"}
      className={config.className}
    >
      {config.text}
    </button>
  );
}
