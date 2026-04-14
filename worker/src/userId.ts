/**
 * Derive a stable, opaque user identifier from a raw auth credential.
 *
 * SHA-256 of the credential, hex-encoded, truncated to 16 chars. Same key
 * always maps to the same id. Raw credentials never enter D1.
 */
export async function userIdFromCredential(credential: string): Promise<string> {
	const data = new TextEncoder().encode(credential);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash))
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
