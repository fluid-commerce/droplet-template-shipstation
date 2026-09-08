/**
 * Fluid API Client
 *
 * Port of app/clients/fluid_client.rb and app/clients/fluid/*.rb.
 *
 * Two differences from the Ruby original, both deliberate:
 *
 *  - The Ruby client set its Authorization header via HTTParty's *class-level*
 *    `headers`, so constructing a second FluidClient mutated the first one's
 *    credentials. Here the token is per-instance.
 *  - `listCallbacks` forwards `{ page, per_page }`. Fluid's index action
 *    defaults to 10 per page and the endpoint is COMPANY-scoped, so a client
 *    that drops the params sees only the first ten of a company's
 *    registrations — including registrations owned by other droplets.
 *
 * Every endpoint used here is real. `/api/company/callbacks` is not, and is
 * not called: the callback endpoints live under `/api/callback/*`.
 */

import { z } from "zod";

export class FluidError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "FluidError";
  }
}

export class FluidAuthenticationError extends FluidError {
  constructor(message: string, status: number, body: string) {
    super(message, status, body);
    this.name = "FluidAuthenticationError";
  }
}

export class FluidResourceNotFoundError extends FluidError {
  constructor(message: string, status: number, body: string) {
    super(message, status, body);
    this.name = "FluidResourceNotFoundError";
  }
}

const createWebhookSchema = z.object({
  resource: z.string(),
  url: z.string().url(),
  active: z.boolean().default(true),
  auth_token: z.string(),
  event: z.string(),
  http_method: z.enum(["post", "get", "put", "delete", "patch"]).default("post"),
});

export type CreateWebhookPayload = z.input<typeof createWebhookSchema>;

export const webhookSchema = z.object({
  id: z.union([z.number(), z.string()]),
  resource: z.string().optional(),
  event: z.string().optional(),
  url: z.string().optional(),
  active: z.boolean().optional(),
});

export type FluidWebhook = z.infer<typeof webhookSchema>;

const createCallbackRegistrationSchema = z.object({
  definition_name: z.string(),
  url: z.string().url(),
  timeout_in_seconds: z.number().int().positive().max(20).optional(),
  active: z.boolean().default(true),
});

export type CreateCallbackRegistrationPayload = z.input<
  typeof createCallbackRegistrationSchema
>;

export const callbackRegistrationSchema = z.object({
  uuid: z.string(),
  definition_name: z.string(),
  url: z.string(),
  active: z.boolean().optional(),
  /**
   * Returned by `api_create` and by `api_index` (via the blueprint's `shared`
   * view). NOT returned by update — `before_create :set_tokens` is the only
   * writer, so a token cannot be rotated in place.
   */
  verification_token: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type CallbackRegistration = z.infer<typeof callbackRegistrationSchema>;

export interface CallbackDefinition {
  name: string;
  description?: string;
  version?: string;
}

export interface DropletPayload {
  name?: string;
  embed_url?: string | null;
  uuid?: string;
  active?: boolean;
  settings?: Record<string, unknown>;
}

export class FluidClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(authToken: string, baseUrl?: string) {
    this.authToken = authToken;
    this.baseUrl = (
      baseUrl ||
      process.env.FLUID_API_URL ||
      "https://api.fluid.app"
    ).replace(/\/$/, "");
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      // The body is included because Fluid puts the validation errors there,
      // and never the request — which is where the credentials would be.
      const body = await response.text();
      const message = `Fluid API error: ${response.status} ${response.statusText}`;
      if (response.status === 401) {
        throw new FluidAuthenticationError(message, response.status, body);
      }
      if (response.status === 404) {
        throw new FluidResourceNotFoundError(message, response.status, body);
      }
      throw new FluidError(message, response.status, body);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // --- Droplets -----------------------------------------------------------

  async getDroplet(uuid: string): Promise<{ droplet: DropletPayload }> {
    return this.request(`/api/droplets/${uuid}`);
  }

  async createDroplet(
    droplet: DropletPayload,
  ): Promise<{ droplet: DropletPayload }> {
    return this.request("/api/droplets", {
      method: "POST",
      body: JSON.stringify({ droplet }),
    });
  }

  async updateDroplet(
    uuid: string,
    droplet: DropletPayload,
  ): Promise<{ droplet: DropletPayload }> {
    return this.request(`/api/droplets/${uuid}`, {
      method: "PUT",
      body: JSON.stringify({ droplet }),
    });
  }

  async deleteDroplet(uuid: string): Promise<void> {
    return this.request(`/api/droplets/${uuid}`, { method: "DELETE" });
  }

  // --- Webhooks -----------------------------------------------------------

  /**
   * GET /api/company/webhooks.
   *
   * PAGINATED, and the default page size is small. fluid's
   * `Api::Company::Webhooks::IndexAction` does
   * `webhooks.page(params[:page] || 1).per(params[:per_page] || 30)`, so a bare
   * call returns at most 30 of a company's webhooks with nothing in the body
   * saying more exist. The listing is also company-scoped rather than
   * droplet-scoped: an active company has webhooks from every droplet it has
   * installed, and 30 is easy to exceed.
   *
   * Callers that need to find OUR webhooks must therefore page to the end.
   * Use `listAllWebhooks()` below rather than remembering to do it by hand —
   * the one place that forgot (the uninstall cleanup) silently examined only
   * the first page.
   */
  async listWebhooks(params?: {
    page?: number;
    per_page?: number;
  }): Promise<{ webhooks: FluidWebhook[] }> {
    const query = new URLSearchParams();
    if (params?.page) query.set("page", String(params.page));
    if (params?.per_page) query.set("per_page", String(params.per_page));
    const suffix = query.size > 0 ? `?${query}` : "";

    return this.request(`/api/company/webhooks${suffix}`);
  }

  /**
   * Every webhook fluid holds for this company, paged to the end.
   *
   * This is the method callers almost always want. A bare `listWebhooks()`
   * returns one page of 30, and the listing is company-scoped rather than
   * droplet-scoped, so an active company carrying several droplets exceeds
   * that easily — 39 for the internal install at the time of writing.
   *
   * Fails loudly at the cap instead of returning a truncated list, because a
   * partial answer is indistinguishable from a complete one at every call site.
   */
  async listAllWebhooks(perPage = 100, maxPages = 50): Promise<FluidWebhook[]> {
    const all: FluidWebhook[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const response = await this.listWebhooks({ page, per_page: perPage });
      const batch = response?.webhooks ?? [];
      all.push(...batch);
      if (batch.length < perPage) return all;
    }
    // A plain Error, not FluidError: nothing here failed at the HTTP layer, so
    // there is no status or body to attach and inventing them would misreport
    // what happened.
    throw new Error(
      `Fluid returned ${maxPages} full pages of webhooks; refusing to act on a ` +
        `list that may be truncated.`,
    );
  }

  async createWebhook(
    payload: CreateWebhookPayload,
  ): Promise<{ webhook: FluidWebhook }> {
    return this.request("/api/company/webhooks", {
      method: "POST",
      body: JSON.stringify({ webhook: createWebhookSchema.parse(payload) }),
    });
  }

  async updateWebhook(
    webhookId: string,
    payload: CreateWebhookPayload,
  ): Promise<{ webhook: FluidWebhook }> {
    return this.request(`/api/company/webhooks/${webhookId}`, {
      method: "PUT",
      body: JSON.stringify({ webhook: createWebhookSchema.parse(payload) }),
    });
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    return this.request(`/api/company/webhooks/${webhookId}`, {
      method: "DELETE",
    });
  }

  // --- Callback definitions ------------------------------------------------

  /** GET /api/callback/definitions — the catalogue the admin UI syncs from. */
  async listCallbackDefinitions(): Promise<{
    definitions: CallbackDefinition[];
  }> {
    return this.request("/api/callback/definitions");
  }

  // --- Callback registrations ----------------------------------------------

  /**
   * GET /api/callback/registrations.
   *
   * `page` and `per_page` are forwarded rather than optional-in-name-only: the
   * endpoint defaults to 10 per page and is scoped to the company, not to this
   * droplet, so a caller that ignores paging silently adopts (or cleans up)
   * only the first ten rows of a list it does not own all of.
   */
  async listCallbacks(params?: {
    page?: number;
    per_page?: number;
    active?: boolean;
    definition_name?: string;
  }): Promise<{ callback_registrations: CallbackRegistration[] }> {
    const query = new URLSearchParams();
    if (params?.page) query.set("page", String(params.page));
    if (params?.per_page) query.set("per_page", String(params.per_page));
    if (params?.active !== undefined) query.set("active", String(params.active));
    if (params?.definition_name) {
      query.set("definition_name", params.definition_name);
    }
    const suffix = query.size > 0 ? `?${query}` : "";

    return this.request(`/api/callback/registrations${suffix}`);
  }

  /**
   * POST /api/callback/registrations.
   *
   * The response is the ONLY place `verification_token` is issued on a new
   * registration, so the caller must persist its digest here or delete the
   * registration again. See registerCallbacksForCompany.
   */
  async createCallback(
    payload: CreateCallbackRegistrationPayload,
  ): Promise<{ callback_registration: CallbackRegistration }> {
    return this.request("/api/callback/registrations", {
      method: "POST",
      body: JSON.stringify({
        callback_registration: createCallbackRegistrationSchema.parse(payload),
      }),
    });
  }

  async getCallback(
    uuid: string,
  ): Promise<{ callback_registration: CallbackRegistration }> {
    return this.request(`/api/callback/registrations/${uuid}`);
  }

  /**
   * PUT /api/callback/registrations/:uuid.
   *
   * Note that Fluid's update action accepts only definition_name, url and
   * active — it will not accept or return `verification_token`.
   */
  async updateCallback(
    uuid: string,
    payload: Partial<CreateCallbackRegistrationPayload>,
  ): Promise<{ callback_registration: CallbackRegistration }> {
    return this.request(`/api/callback/registrations/${uuid}`, {
      method: "PUT",
      body: JSON.stringify({ uuid, callback_registration: payload }),
    });
  }

  async deleteCallback(uuid: string): Promise<void> {
    return this.request(`/api/callback/registrations/${uuid}`, {
      method: "DELETE",
    });
  }
}

export function createFluidClient(
  authToken: string,
  baseUrl?: string,
): FluidClient {
  return new FluidClient(authToken, baseUrl);
}
