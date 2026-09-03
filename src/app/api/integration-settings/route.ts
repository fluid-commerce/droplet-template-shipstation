/**
 * Port of IntegrationSettingsController#create.
 *
 * Upserts the current company's ShipStation configuration. Every field is
 * optional and absent means "leave it alone" — see saveIntegrationSetting, which
 * is where the partial-save rules live.
 */

import { NextResponse } from "next/server";

import { withDri } from "@/lib/dri";
import {
  IntegrationSettingValidationError,
  saveIntegrationSetting,
} from "@/lib/integration-settings";

interface Body {
  integration_setting?: {
    api_key?: string;
    api_secret?: string;
    v2_api_key?: string;
    api_version?: string;
    hold_for_batch?: boolean | string;
    batch_window_minutes?: number | string;
    store_id?: string;
  };
}

export const POST = withDri<Body>(async (company, body) => {
  const params = body.integration_setting ?? {};

  try {
    const setting = await saveIntegrationSetting(company.id, {
      secrets: {
        ...("api_key" in params ? { api_key: params.api_key } : {}),
        ...("api_secret" in params ? { api_secret: params.api_secret } : {}),
        ...("v2_api_key" in params ? { v2_api_key: params.v2_api_key } : {}),
      },
      ...("hold_for_batch" in params
        ? { holdForBatch: toBoolean(params.hold_for_batch) }
        : {}),
      ...("batch_window_minutes" in params
        ? { batchWindowMinutes: toMinutes(params.batch_window_minutes) }
        : {}),
      ...("api_version" in params ? { apiVersion: String(params.api_version) } : {}),
      ...("store_id" in params ? { storeId: params.store_id ?? null } : {}),
    });

    return NextResponse.json({ id: String(setting.id) }, { status: 201 });
  } catch (error) {
    if (error instanceof IntegrationSettingValidationError) {
      return NextResponse.json({ errors: error.errors }, { status: 422 });
    }
    throw error;
  }
});

/** Matches ActiveModel::Type::Boolean, which the Rails controller used. */
function toBoolean(value: boolean | string | undefined): boolean {
  if (typeof value === "boolean") return value;
  return !["", "0", "f", "false", "off", "no", undefined, null].includes(
    typeof value === "string" ? value.toLowerCase() : value,
  );
}

/** Blank clears the window (manual release); anything else is validated. */
function toMinutes(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  return Number.parseInt(String(value), 10);
}
