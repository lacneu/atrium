/** Opt-in exclusive SSO; unknown values must never enable another provider. */
export function autheliaOnlyLogin(): boolean {
  const mode = process.env.AUTH_LOGIN_MODE ?? "providers";
  if (mode !== "providers" && mode !== "authelia-only") {
    throw new Error("Invalid AUTH_LOGIN_MODE; expected providers or authelia-only.");
  }
  return mode === "authelia-only";
}
