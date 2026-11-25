/**
 * Handwriting gift-card payment codes (amendment 3b). A short code for the maintainer's payments: six symbols from an
 * alphabet without the look-alikes 0/O/1/I/L, derived as HMAC-SHA256(CONTRIBUTOR_PAYMENT_CODE_SECRET,
 * "heocr-payment-code/v1/" + writer code). Nothing stores it; the writer's own screen and the operator view derive it.
 */
export const PAYMENT_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAYMENT_CODE_LENGTH = 6;
export const paymentMessage = (writer: string) => `heocr-payment-code/v1/${writer}`;

/** The first 8 MAC bytes as a number, written in base 31, six symbols. */
export function paymentCodeFromMac(mac: Uint8Array): string {
  let n = 0n;
  for (const byte of mac.subarray(0, 8)) n = (n << 8n) | BigInt(byte);
  let code = "";
  for (let i = 0; i < PAYMENT_CODE_LENGTH; i++) {
    code += PAYMENT_ALPHABET[Number(n % 31n)];
    n /= 31n;
  }
  return code;
}

/** Codes per writer, or null when two writers would share a code (fail closed: show none). */
export function collisionFree(codes: Map<string, string>): Map<string, string> | null {
  return new Set(codes.values()).size === codes.size ? codes : null;
}
