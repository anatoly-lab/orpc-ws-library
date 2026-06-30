// The contract-bound server→client handler hook for this app.
//
// `createServerHandlerHook<ClientContract>()` binds the SERVER→CLIENT contract
// ONCE here, so every call site (`useServerHandler("showToast", …)`) is fully
// typed — `name` is constrained to the contract's procedures and the handler's
// input/output are pinned per procedure. Bind once at module scope, import the
// returned hook wherever a server→client procedure is implemented (it must run
// under an `<OrpcWs clientContract={clientContract}>` ancestor).

import { createServerHandlerHook } from "@orpc-ws/react";

import type { ClientContract } from "@demo/authless-contract";

export const useServerHandler = createServerHandlerHook<ClientContract>();
