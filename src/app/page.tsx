/**
 * Port of app/views/home/index.html.erb + HomeController#index.
 *
 * The page Fluid embeds in an iframe. It is rendered on the server so the
 * "is this credential set?" flags can be read from the database — and so the
 * credentials themselves never leave it. The browser learns only WHETHER each
 * secret is configured, never its value; see src/lib/integration-settings.ts.
 */

import Link from "next/link";

import { prisma } from "@/lib/db";
import {
  isSandboxKey,
  secretsOf,
} from "@/lib/integration-settings";
import { DropletUi } from "@/components/embedded/droplet-ui";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ dri?: string }>;
}) {
  const { dri = "" } = await searchParams;

  const company = dri
    ? await prisma.company.findFirst({
        where: { dropletInstallationUuid: dri, active: true },
        include: { integrationSetting: true },
      })
    : null;

  const setting = company?.integrationSetting ?? null;
  const secrets = secretsOf(setting);

  return (
    <>
      <header className="flex justify-end bg-gray-100 p-2">
        <Link href="/login" className="text-sm text-blue-600 hover:text-orange-600">
          Sign in
        </Link>
      </header>
      <DropletUi
        dri={dri}
        apiKeySet={!!secrets.api_key}
        apiSecretSet={!!secrets.api_secret}
        holdForBatch={setting?.holdForBatch ?? false}
        batchWindowMinutes={
          setting?.batchWindowMinutes ? String(setting.batchWindowMinutes) : ""
        }
        apiVersion={setting?.apiVersion ?? "v1"}
        v2ApiKeySet={!!secrets.v2_api_key}
        v2Sandbox={isSandboxKey(secrets.v2_api_key)}
        storeId={setting?.storeId ?? ""}
      />
    </>
  );
}
