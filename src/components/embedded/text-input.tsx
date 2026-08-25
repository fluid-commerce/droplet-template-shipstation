"use client";

/** Port of app/frontend/components/input/TextInput.tsx. */

import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string;
}

export function TextInput({ className, id, error, label, ...props }: TextInputProps) {
  return (
    <div className="w-full max-w-md">
      {label && (
        <div className="px-1 pb-2 text-sm font-medium text-gray-700">{label}</div>
      )}
      <input
        id={id}
        className={cn(
          "block w-full rounded-md border-0 px-3 py-2 text-gray-900 shadow-xs ring-1 ring-inset placeholder:text-gray-400 focus:ring-2 focus:ring-inset sm:text-sm/6",
          error ? "ring-red-300 focus:ring-red-500" : "ring-gray-300 focus:ring-blue-600",
          className,
        )}
        {...props}
      />
      {error && <p className="mt-1 px-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
