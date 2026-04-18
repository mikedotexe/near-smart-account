#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  formatTimestampNs,
  nearDataGet,
  sleep,
} from "./lib/fastnear.mjs";

const { values } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    kind: { type: "string", default: "final" },
    interval: { type: "string", default: "2" },
    once: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (!["final", "optimistic"].includes(values.kind)) {
  console.error("--kind must be 'final' or 'optimistic'");
  process.exit(1);
}

const intervalMs = Math.max(0.25, Number(values.interval || "2")) * 1000;
const pathname =
  values.kind === "optimistic"
    ? "/v0/last_block/optimistic"
    : "/v0/last_block/final";

let lastHeight = null;

while (true) {
  const { data, response } = await nearDataGet(values.network, pathname);
  const url = new URL(response.url);
  const heightMatch = url.pathname.match(/\/v0\/block(?:_opt)?\/(\d+)$/);
  const height =
    (heightMatch && Number(heightMatch[1])) || data.block?.header?.height || null;
  const author = data.block?.author || data.block?.header?.author || "?";
  const timestamp =
    data.block?.header?.timestamp_nanosec ?? data.block?.header?.timestamp ?? null;
  const shardCount = Array.isArray(data.shards) ? data.shards.length : 0;

  if (values.json) {
    console.log(JSON.stringify({ url: `${url.origin}${url.pathname}`, data }, null, 2));
    if (values.once) break;
  } else if (height !== lastHeight) {
    console.log(
      `${values.kind} height=${height ?? "?"} author=${author} shards=${shardCount} at=${formatTimestampNs(timestamp)}`
    );
    lastHeight = height;
    if (values.once) break;
  }

  if (values.once) break;
  await sleep(intervalMs);
}
