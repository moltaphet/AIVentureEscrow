import { localnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";

export const NETWORK_NAME = "studionet" as const;
export const NETWORK_LABEL = "GenLayer Studionet";
export const CHAIN_ID = 61999;
export const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}` as `0x${string}`;
export const RPC_OVERRIDE = (import.meta.env.VITE_GENLAYER_RPC_URL as string | undefined)?.trim() || "";
export const CONTRACT_ADDRESS =
  ((import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined)?.trim() as `0x${string}` | undefined) || null;

export const CHAIN = studionet;
export const CHAINS = { localnet, studionet, testnetAsimov, testnetBradbury } as const;

export const EXPLORER_URL = CHAIN.blockExplorers?.default.url || "https://explorer.genlayer.com";

export const DEPLOYMENT_STATUS = CONTRACT_ADDRESS ? "configured" : "not_deployed";

export function isConfigured(): boolean {
  return Boolean(CONTRACT_ADDRESS);
}
