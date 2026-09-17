// ---------------------------------------------------------------------------
// Server-side admin password verification.
//
// Security note: this module runs ONLY on the server. TanStack Start compiles
// the `createServerFn` handler body out of the client bundle (the browser only
// receives a reference that POSTs to the server route), so the password — and
// the default below — never appear in shipped JavaScript. The client can no
// longer be bypassed by reading page source.
//
// Configuration:
//   ADMIN_PASSWORD  — set this in the deployment environment (e.g. Vercel →
//                     Project Settings → Environment Variables). When it is set
//                     and non-empty, the submitted password must match it
//                     exactly.
//
// Fallback (no env var configured):
//   If ADMIN_PASSWORD is missing or empty, verification falls back to the
//   historical default `UnlockAI786`. This keeps the CTO.new preview working
//   with zero setup. Production deployments should always set ADMIN_PASSWORD,
//   because with the fallback active anyone who knows the old default can
//   unlock — the fallback exists only for local/preview convenience.
// ---------------------------------------------------------------------------
import { createServerFn } from "@tanstack/react-start";

/** Historical client-side default, retained as the no-env fallback only. */
const FALLBACK_ADMIN_PASSWORD = "UnlockAI786";

export interface AdminVerifyResult {
  ok: boolean;
}

export const verifyAdminPassword = createServerFn({ method: "POST" })
  .validator((d: unknown): { password: string } => {
    if (typeof d === "string") return { password: d };
    if (d && typeof d === "object" && "password" in d) {
      const value = (d as { password?: unknown }).password;
      return { password: typeof value === "string" ? value : "" };
    }
    return { password: "" };
  })
  .handler(async ({ data }): Promise<AdminVerifyResult> => {
    const envPassword = process.env.ADMIN_PASSWORD;
    // A set, non-empty env var always wins; otherwise fall back to the default
    // so the preview environment works without configuration.
    const expected =
      typeof envPassword === "string" && envPassword.length > 0
        ? envPassword
        : FALLBACK_ADMIN_PASSWORD;

    const submitted = data?.password ?? "";
    // Plain constant-ish comparison — the password is short-lived admin access,
    // not a stored user credential, so a simple exact match is sufficient here
    // and keeps the function dependency-free.
    const ok = submitted.length > 0 && submitted === expected;
    return { ok };
  });
