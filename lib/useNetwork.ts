'use client';
import { useState, useEffect } from 'react';
import { NetworkId, NETWORKS } from './networks';

const STORAGE_KEY = 'monad-stats:network';

export function useNetwork(): [NetworkId, (n: NetworkId) => void] {
  const [network, setNetworkState] = useState<NetworkId>('testnet');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && stored in NETWORKS && NETWORKS[stored as NetworkId].active) {
        setNetworkState(stored as NetworkId);
      }
    } catch { /* no-op */ }
  }, []);

  const setNetwork = (n: NetworkId) => {
    setNetworkState(n);
    try { localStorage.setItem(STORAGE_KEY, n); } catch { /* no-op */ }
  };

  return [network, setNetwork];
}
