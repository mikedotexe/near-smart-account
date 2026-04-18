/** @type { import("https://unpkg.com/@fastnear/api/dist/esm/index.d.ts") } */
/* global near */
// index.js — wireUpAppEarly / wireUpAppLate split (matches the reference at
// /Users/mikepurvis/near/hack-fastdata/reference-static-template/index.js).
//
// Responsibilities:
//   - Configure near-api for testnet (Early)
//   - Wire router demo buttons (flat promise shapes) to near.sendTx (Late)
//   - On each observed tx event, re-run trace.js → re-render the panel

import { traceTx, renderText, classify } from "./trace.js";

const NET = "testnet";
const RPC_BASE = "https://rpc.testnet.fastnear.com";
const API_KEY_STORAGE = "FASTNEAR_API_KEY";

const state = {
  router: "router.x.mike.testnet",
  echoA: "echo.x.mike.testnet",
  echoB: "echo-b.x.mike.testnet",
  apiKey: readApiKey(),  // localStorage wins over config.local.js default
  pinnedTxHash: null,   // sticky tx hash for trace panel
  lastTxHash: null,     // most recent observed tx (auto-advances unless pinned)
  lastSender: null,
  autoPollHandle: null,
};

// localStorage beats window.FASTNEAR_API_KEY so runtime paste wins without
// forcing a config.local.js edit. Either source is fine.
function readApiKey() {
  try {
    const ls = localStorage.getItem(API_KEY_STORAGE);
    if (ls) return ls;
  } catch { /* localStorage can be disabled */ }
  return (typeof window !== "undefined" && window.FASTNEAR_API_KEY) || "";
}

// Returns RPC_BASE with ?apiKey=... appended when we have a key. Used for
// near.config({ nodeUrl }) so @fastnear/api inherits the key on every call.
function rpcUrl(apiKey) {
  if (!apiKey) return RPC_BASE;
  const u = new URL(RPC_BASE);
  u.searchParams.set("apiKey", apiKey);
  return u.toString();
}

export function wireUpAppEarly(configOpts = {}) {
  near.config({ networkId: NET, nodeUrl: rpcUrl(state.apiKey), ...configOpts });
}

export function wireUpAppLate() {
  hydrateConfigInputs();
  renderAuth();
  wireDemoButtons();
  wireTraceForm();

  // @fastnear/api fires events as a tx moves through statuses; we treat each
  // emission as "maybe re-run our DAG walker". The pin logic below decides
  // whether the observed hash should displace the current trace focus.
  // Reference: reference-static-template/index.js:311.
  near.event.onTx((txStatus) => {
    const hash = txStatus?.transaction?.hash ?? txStatus?.txHash;
    if (!hash) return;
    state.lastTxHash = hash;
    state.lastSender = near.accountId() || state.lastSender;
    if (!state.pinnedTxHash) {
      document.getElementById("trace-hash").value = hash;
      document.getElementById("trace-sender").value = state.lastSender ?? "";
    }
    scheduleTrace();
  });

  near.event.onAccount(() => renderAuth());
}

function hydrateConfigInputs() {
  const bind = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = state[key];
    el.addEventListener("change", () => {
      state[key] = el.value.trim();
    });
  };
  bind("cfg-router", "router");
  bind("cfg-echo-a", "echoA");
  bind("cfg-echo-b", "echoB");

  // API key gets its own binding: persists to localStorage and re-points
  // @fastnear/api's nodeUrl so subsequent view/send calls inherit the key.
  const keyEl = document.getElementById("cfg-api-key");
  if (keyEl) {
    keyEl.value = state.apiKey;
    keyEl.addEventListener("change", () => {
      state.apiKey = keyEl.value.trim();
      try {
        if (state.apiKey) localStorage.setItem(API_KEY_STORAGE, state.apiKey);
        else localStorage.removeItem(API_KEY_STORAGE);
      } catch { /* storage disabled — that's fine */ }
      near.config({ nodeUrl: rpcUrl(state.apiKey) });
    });
  }
}

// -----------------------------------------------------------------------------
// Sign-in / auth panel (minimal)
// -----------------------------------------------------------------------------
function renderAuth() {
  const el = document.getElementById("auth");
  if (!el) return;
  if (near.authStatus() === "SignedIn") {
    el.innerHTML = `
      <span class="code">${escape(near.accountId())}</span>
      <button id="sign-out" class="demo-btn" style="background:#555">sign out</button>
    `;
    document.getElementById("sign-out").onclick = () => {
      near.signOut();
      location.reload();
    };
    setDemoStatus(`signed in as ${near.accountId()} (session key valid for selected contract)`);
  } else {
    el.innerHTML = `
      <input id="signin-contract" class="input-reset ba b--white-30 pa1 br1 code mr1" value="${state.router}"/>
      <button id="sign-in" class="demo-btn">sign in · create session key</button>
    `;
    document.getElementById("sign-in").onclick = () => {
      const contractId =
        document.getElementById("signin-contract").value.trim() || state.router;
      near.requestSignIn({ contractId });
    };
  }
}

// -----------------------------------------------------------------------------
// Demo buttons
// -----------------------------------------------------------------------------
function wireDemoButtons() {
  // -- router: flat promise shapes --
  document.getElementById("demo-single-hop").onclick = () =>
    submit(state.router, "route_echo", { callee: state.echoA, n: 42 });

  document.getElementById("demo-then").onclick = () =>
    submit(state.router, "route_echo_then", { callee: state.echoA, n: 7 });

  document.getElementById("demo-and").onclick = () =>
    submit(state.router, "route_echo_and", { callees: [state.echoA, state.echoB], n: 3 });
}

async function submit(receiverId, methodName, args, gas, opts = {}) {
  if (near.authStatus() !== "SignedIn") {
    setDemoStatus("sign in first to create a session key");
    return;
  }
  const cu = near.utils.convertUnit;
  const gasVal = gas ? (typeof gas === "string" ? cu(gas) : gas) : cu("30 Tgas");
  try {
    const res = await near.sendTx({
      receiverId,
      actions: [
        near.actions.functionCall({
          methodName,
          args,
          gas: gasVal,
          deposit: "0",
        }),
      ],
    });
    const hash = res?.transaction?.hash;
    setDemoStatus(`submitted ${receiverId}.${methodName} → ${hash ?? "(no hash)"}`);
    if (hash) {
      state.lastTxHash = hash;
      state.lastSender = near.accountId();
      if (!opts.pinTrace) {
        // If the caller didn't ask us to preserve the pinned trace, overwrite
        // the trace panel with this fresh tx.
        state.pinnedTxHash = null;
        document.getElementById("trace-hash").value = hash;
        document.getElementById("trace-sender").value = near.accountId() ?? "";
      }
    }
    return res;
  } catch (err) {
    console.error(err);
    setDemoStatus(`${receiverId}.${methodName} failed: ${err?.message ?? err}`);
  }
}

function setDemoStatus(msg) {
  const el = document.getElementById("demo-status");
  if (el) el.textContent = msg;
}

// -----------------------------------------------------------------------------
// "Trace a hash" form and the re-polling loop used for yield/resume.
// -----------------------------------------------------------------------------
function wireTraceForm() {
  document.getElementById("trace-run").onclick = () => {
    state.pinnedTxHash = document.getElementById("trace-hash").value.trim() || null;
    state.lastSender = document.getElementById("trace-sender").value.trim();
    scheduleTrace(true);
  };
}

function scheduleTrace(immediate = false) {
  if (state.autoPollHandle) {
    clearTimeout(state.autoPollHandle);
    state.autoPollHandle = null;
  }
  const run = async () => {
    const hash = state.pinnedTxHash ?? state.lastTxHash;
    const sender = state.lastSender;
    if (!hash || !sender) return;
    const waitUntil = document.getElementById("trace-wait").value;
    const { error, tree, classification } = await traceTx({
      txHash: hash,
      senderId: sender,
      waitUntil,
      apiKey: state.apiKey,
    });

    const summary = document.getElementById("trace-summary");
    const treeEl = document.getElementById("trace-tree");
    if (error) {
      summary.innerHTML = `<span class="classify classify-HARD_FAIL">ERROR</span> <code>${escape(
        JSON.stringify(error)
      )}</code>`;
      treeEl.textContent = "";
      return;
    }
    summary.innerHTML =
      `<span class="classify classify-${classification}">${classification}</span> ` +
      `· tx <code>${shortHash(tree.txHash)}</code> ` +
      `· finality <code>${tree.finality}</code>` +
      (state.pinnedTxHash ? ` · <span class="f7 o-70">📌 pinned</span>` : "");
    treeEl.textContent = renderText(tree);

    // Auto-poll every 3 s while PENDING (covers yield/resume). FINAL can take
    // up to ~4 min with an active yield — see chapter §1.9.
    if (classification === "PENDING") {
      state.autoPollHandle = setTimeout(run, 3000);
    }
  };
  if (immediate) run();
  else state.autoPollHandle = setTimeout(run, 500);
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
function shortHash(h) {
  return h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "?";
}
function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
