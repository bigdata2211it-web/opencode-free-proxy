import { randomBytes } from "crypto";

const LENGTH = 26;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let counter = 0;

function randomBase62(length) {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) result += BASE62[bytes[i] % 62];
  return result;
}

/**
 * OpenCode Identifier.create("ascending") — Zen's free-tier gate
 * (FreeTierError) rejects anything that isn't prefix_ + 12 hex time bytes
 * + 14 base62 chars.
 */
export function ocId(prefix) {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp;
    counter = 0;
  }
  counter++;

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  return `${prefix}_${timeBytes.toString("hex")}${randomBase62(LENGTH - 12)}`;
}
