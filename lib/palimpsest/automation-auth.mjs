async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function hasAutomationAccess(authorization, configuredToken) {
  const header = typeof authorization === "string" ? authorization.trim() : "";
  const suppliedToken = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";
  const expectedToken =
    typeof configuredToken === "string" ? configuredToken.trim() : "";
  if (suppliedToken.length < 32 || expectedToken.length < 32) return false;

  const [suppliedHash, expectedHash] = await Promise.all([
    sha256Hex(suppliedToken),
    sha256Hex(expectedToken),
  ]);
  let mismatch = suppliedHash.length ^ expectedHash.length;
  for (let index = 0; index < suppliedHash.length; index += 1) {
    mismatch |= suppliedHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return mismatch === 0;
}
