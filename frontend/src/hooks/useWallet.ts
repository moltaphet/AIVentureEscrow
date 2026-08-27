import { useCallback, useEffect, useState } from "react";
import { CHAIN_ID } from "../config";
import { stringifyError } from "../lib/errors";
import {
  connectWallet,
  connectedAddress,
  disconnectWallet,
  initializeWallet,
  readWalletState,
} from "../lib/contract";
import type { WalletState } from "../types";

const EMPTY_WALLET: WalletState = {
  address: null,
  balance: 0n,
  chainId: null,
};

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>(EMPTY_WALLET);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (address?: string | null) => {
    const nextAddress = address || connectedAddress();
    if (!nextAddress || !window.ethereum) {
      setWallet(EMPTY_WALLET);
      return;
    }
    try {
      await initializeWallet(nextAddress);
      const state = await readWalletState(nextAddress);
      setWallet({ address: nextAddress.toLowerCase(), ...state });
    } catch (readError) {
      setError(stringifyError(readError));
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError("");
    try {
      const address = await connectWallet();
      await refresh(address);
    } catch (connectError) {
      setError(stringifyError(connectError));
      throw connectError;
    } finally {
      setConnecting(false);
    }
  }, [refresh]);

  const disconnect = useCallback(() => {
    disconnectWallet();
    setWallet(EMPTY_WALLET);
    setError("");
  }, []);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return undefined;

    const inspect = async () => {
      const accounts = await provider.request({ method: "eth_accounts" });
      const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
      await refresh(address);
    };
    void inspect();

    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0];
      const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
      if (!address) disconnect();
      else void refresh(address);
    };
    const onChainChanged = () => void refresh(connectedAddress());
    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("chainChanged", onChainChanged);

    return () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, [disconnect, refresh]);

  return {
    ...wallet,
    connecting,
    error,
    supportedChain: wallet.chainId === CHAIN_ID,
    connect,
    disconnect,
    refresh: () => refresh(wallet.address),
  };
}
