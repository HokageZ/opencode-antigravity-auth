/**
 * Vendored PKCE pair generator.
 *
 * Equivalent to `generatePKCE` from `@openauthjs/openauth/pkce` (which merely
 * wrapped `jose`'s base64url), kept dependency-free so the V2 plugin graph has
 * no runtime bare-specifier imports.
 */

export interface PkcePair {
  challenge: string;
  verifier: string;
  method: "S256";
}

function base64url(buffer: Uint8Array): string {
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateVerifier(length: number): string {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

async function generateChallenge(verifier: string, method: "S256" | "plain"): Promise<string> {
  if (method === "plain") return verifier;
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}

export async function generatePKCE(length = 64): Promise<PkcePair> {
  if (length < 43 || length > 128) {
    throw new Error("Code verifier length must be between 43 and 128 characters");
  }
  const verifier = generateVerifier(length);
  const challenge = await generateChallenge(verifier, "S256");
  return { verifier, challenge, method: "S256" };
}